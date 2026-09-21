/**
 * konkurrenter.js – overvåker konkurrenter via:
 *   1) Doffin (kunngjøringer + intensjonskunngjøringer + tildelinger)
 *   2) Brønnøysund (SPV/datterselskaper med konkurrantnavn i firmanavn)
 *   3) Google News-lenker (åpnes i nettleser)
 *
 * Kjøres ukentlig av GitHub Actions.
 * Leser:  konkurrenter.json
 * Skriver: konkurrenter-data.json
 */

const fs = require('fs');

const DOFFIN_KEY  = process.env.DOFFIN_API_KEY || '';
const DOFFIN_BASE = 'https://api.doffin.no/public/v2';
const BRREG_BASE  = 'https://data.brreg.no/enhetsregisteret/api';
const PAUSE       = Number(process.env.PAUSE || 350);

// ---- Hjelpere ----------------------------------------------------------------
const norm = s => (s || '').toString().toLowerCase();
const tekstAv = v => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(tekstAv).join(' ');
  if (typeof v === 'object') {
    for (const k of ['no','nb','en','value','text','name']) if (v[k]) return tekstAv(v[k]);
    return Object.values(v).map(tekstAv).join(' ');
  }
  return String(v);
};

async function hent(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      ...opts, redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Allstad-analyse/1.0', Accept: 'application/json', ...(opts.headers || {}) }
    });
    return { ok: r.ok, status: r.status, tekst: (await r.text()).slice(0, 800000) };
  } catch (e) {
    return { ok: false, status: 0, tekst: '', feil: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// ---- Brønnøysund: finn SPV-er – kun relevante NACE-koder og firmanavn ------

// NACE-koder: pleie/helse + eiendomsutvikling + byggeprosjekt
const RELEVANTE_NACE = [
  '87',    // Omsorgsboliger, sykehjem, pleieinstitusjoner (87.10, 87.20, 87.30, 87.90)
  '86',    // Helsetjenester
  '68.1',  // Kjøp og salg av egen fast eiendom
  '68.2',  // Drift av egne eller leide eiendommer
  '41.1',  // Utvikling av byggeprosjekter
  '41.2',  // Oppføring av bygninger
];

// Firmanavn-ord som røper omsorgsrelevant SPV
const SPV_NAVN_ORD = [
  'omsorg', 'sykehjem', 'helsehus', 'helse', 'bofellesskap', 'omsorgsbolig',
  'bo og', 'bo-og', 'eldrebo', 'eldresenter', 'omsorgsbygg', 'helsebygg',
  'omsorgssenter', 'behandlingssenter', 'bokonsept', 'pleie', 'demens',
  'eiendom', 'utbygging', 'utvikling', 'invest', 'holding', 'prosjekt',
  'eiendomsselskap', 'eiendomsutvikling'
];

function erRelevantNace(enheten) {
  const nacer = [
    enheten.naeringskode1, enheten.naeringskode2, enheten.naeringskode3
  ].filter(Boolean).map(n => (n.kode || '').replace(/\./g, '').slice(0, 4));
  return nacer.some(k => RELEVANTE_NACE.some(r => k.startsWith(r.replace('.', '').replace(/\./g, ''))));
}

function erRelevantNavn(firmanavn) {
  const n = norm(firmanavn);
  return SPV_NAVN_ORD.some(o => n.includes(o));
}

async function finnSPV(søkenavn) {
  const r = await hent(`${BRREG_BASE}/enheter?navn=${encodeURIComponent(søkenavn)}&size=100&page=0`);
  if (!r.ok) return [];
  let j; try { j = JSON.parse(r.tekst); } catch { return []; }
  const enheter = (j._embedded && j._embedded.enheter) || [];

  return enheter
    .filter(e => {
      if (!e.navn || !e.organisasjonsnummer) return false;
      if (!norm(e.navn).includes(norm(søkenavn))) return false;
      // krev enten riktig NACE-kode ELLER relevant firmanavn
      return erRelevantNace(e) || erRelevantNavn(e.navn);
    })
    .map(e => {
      const adr = e.forretningsadresse || e.beliggenhetsadresse || {};
      const nacer = [e.naeringskode1, e.naeringskode2].filter(Boolean)
        .map(n => n.beskrivelse || n.kode || '').join(' / ');
      return {
        org: e.organisasjonsnummer,
        navn: e.navn,
        nace: nacer,
        kommuneNr: adr.kommunenummer || null,
        kommuneNavn: adr.kommune || null,
        ansatte: e.antallAnsatte || 0
      };
    });
}

// ---- Doffin: søk med utvidede søkeord og intensjonskunngjøringer -------------
const BYGGTYPE = [
  'omsorgsbolig', 'sykehjem', 'helsehus', 'bofellesskap', 'omsorgssenter',
  'eldrebolig', 'aldershjem', 'bo- og behandlingssenter', 'heldøgns'
];
const BYGGESIGNAL = [
  'totalentreprise', 'entreprise', 'nybygg', 'tilbygg', 'oppføring', 'utvidelse',
  'bygging', 'rehabilitering av', 'prosjektering', 'markedsdialog', 'samspillsentreprise',
  'utbygging', 'etablering av', 'forprosjekt', 'rammetillatelse', 'anskaffelse av sykehjem',
  'anskaffelse av omsorgsbolig', 'prekvalifisering', 'totalprosjekt', 'intensjonskunngjøring'
];
const UTELUKK = [
  'rammeavtale', 'matvarer', 'sengetøy', 'inkontinens', 'ventilasjon', 'gulvlegging',
  'stillastjenest', 'tjenestetilbud', 'tjenestekjøp', 'konkurranseutsetting',
  'drift av sykehjem', 'drift av omsorgs', 'renhold', 'vaskeri', 'kjøkken'
];

function kommuneFraTekst(tekst) {
  if (!tekst) return null;
  const t = norm(tekst);
  const m = t.match(/([a-zæøå\-\s]{3,40}?)\s+kommune/i);
  if (!m) return null;
  let n = m[1].trim().replace(/^(i|for|til|hos|av|fra|ved|og)\s+/i, '');
  if (/\s/.test(n)) n = n.split(/\s+/).pop();
  return n.length >= 2 ? n : null;
}

async function søkDoffin(søkeord, erSPV = false) {
  const funn = [];
  const headers = { Accept: 'application/json' };
  if (DOFFIN_KEY) headers['Ocp-Apim-Subscription-Key'] = DOFFIN_KEY;

  // søk også etter intensjonskunngjøringer
  const søk = erSPV
    ? [søkeord]
    : [søkeord, søkeord + ' intensjonskunngjøring'];

  for (const q of søk) {
    const r = await hent(
      `${DOFFIN_BASE}/search?searchString=${encodeURIComponent(q)}&numHitsPerPage=50&page=1`,
      { headers }
    );
    if (!r.ok) continue;
    let j; try { j = JSON.parse(r.tekst); } catch { continue; }
    const liste = j.hits || j.results || j.notices || j.items || j.value || [];

    for (const n of liste) {
      const tittel = tekstAv(n.heading || n.title || n.name || '');
      const kjoper = tekstAv(n.buyer || n.organisationName || '');
      const besk   = tekstAv(n.description || n.shortDescription || '');
      const type   = tekstAv(n.type || n.noticeType || '');
      const cpv    = tekstAv(n.cpvCodes || '');
      const samlet = norm(tittel + ' ' + kjoper + ' ' + besk);
      const id     = tekstAv(n.id || n.noticeId || '');

      // har konkurrenten noe med dette å gjøre?
      if (!norm(søkeord.split(' ')[0]).split('').every((c, i) =>
        norm(søkeord)[i] === c) && !samlet.includes(norm(søkeord.split(' ')[0]))) continue;
      if (funn.some(x => x.id === id && id)) continue;

      const harBygg     = BYGGTYPE.some(o => samlet.includes(o)) || /4521[0-9]/.test(cpv);
      const harByggesig = BYGGESIGNAL.some(o => samlet.includes(o));
      const erStøy      = UTELUKK.some(o => samlet.includes(o));
      const erIntensjon = /intensjon/i.test(type + ' ' + tittel);
      const erTildeling = /tildeling|award/i.test(type + ' ' + tittel);

      if (!harBygg) continue;
      if (!harByggesig && !erIntensjon && !erTildeling) continue;
      if (erStøy && !/4521[0-9]/.test(cpv)) continue;

      const kommune = kommuneFraTekst(kjoper) || kommuneFraTekst(tittel);
      const pub = tekstAv(n.publicationDate || n.issueDate || '');
      const url = tekstAv(n.doffinClassicUrl || (id ? `https://www.doffin.no/notices/${id}` : ''));

      let etikett = 'Kunngjøring';
      if (erIntensjon) etikett = 'Intensjonskunngjøring';
      else if (erTildeling) etikett = 'Tildeling';
      else if (/markedsdialog|dialogkonferanse/i.test(samlet)) etikett = 'Markedsdialog';
      else if (/konkurranse/i.test(type)) etikett = 'Konkurranse';

      const score = (erTildeling ? 3 : 0) + (erIntensjon ? 2 : 0) + (harBygg ? 2 : 0);

      funn.push({
        id, tittel: tittel.slice(0, 200), kjoper: kjoper.slice(0, 100),
        type: etikett, dato: pub.slice(0, 10),
        frist: tekstAv(n.deadline || '').slice(0, 10),
        harBygg, erTildeling, erIntensjon, score,
        kommune, url, fraSpv: erSPV
      });
    }
    await new Promise(r => setTimeout(r, PAUSE));
  }
  funn.sort((a, b) => (b.score - a.score) || (b.dato || '').localeCompare(a.dato || ''));
  return funn.slice(0, 20);
}

// ---- Nominatim: hent koordinater for en norsk kommune -----------------------
const _geoCache = {};
async function hentKoordinater(kommuneNavn) {
  if (!kommuneNavn) return null;
  const k = norm(kommuneNavn);
  if (_geoCache[k]) return _geoCache[k];
  await new Promise(r => setTimeout(r, 1100)); // Nominatim: maks 1/sek
  const r = await hent(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(kommuneNavn + ' kommune, Norge')}&format=json&limit=1`,
    { headers: { 'Accept-Language': 'no', 'User-Agent': 'Allstad-analyse/1.0' } }
  );
  if (!r.ok) return null;
  let j; try { j = JSON.parse(r.tekst); } catch { return null; }
  if (!j.length) return null;
  const pos = { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
  _geoCache[k] = pos;
  return pos;
}

// ---- Hoved ------------------------------------------------------------------
(async () => {
  if (!fs.existsSync('konkurrenter.json')) { console.error('Mangler konkurrenter.json'); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync('konkurrenter.json', 'utf8'));
  const selskaper = cfg.selskaper || [];
  console.log(`Overvåker ${selskaper.length} konkurrenter (Doffin + SPV + kart) ...`);

  const resultat = {};

  for (let i = 0; i < selskaper.length; i++) {
    const s = selskaper[i];
    process.stdout.write(`  [${i+1}/${selskaper.length}] ${s.navn} ...`);

    // 1) finn SPV-er
    const spvListe = [];
    for (const sokOrd of s.søkeord) {
      const spver = await finnSPV(sokOrd);
      spver.forEach(sp => { if (!spvListe.some(x => x.org === sp.org)) spvListe.push(sp); });
      await new Promise(r => setTimeout(r, 250));
    }

    // 2) søk Doffin med opprinnelige søkeord + SPV-navn
    const alleDoffin = [];
    for (const sokOrd of s.søkeord) {
      const funn = await søkDoffin(sokOrd, false);
      funn.forEach(f => { if (!alleDoffin.some(x => x.id === f.id)) alleDoffin.push(f); });
    }
    for (const spv of spvListe.slice(0, 8)) {
      const funn = await søkDoffin(spv.navn, true);
      funn.forEach(f => {
        if (!alleDoffin.some(x => x.id === f.id))
          alleDoffin.push({ ...f, fraSpv: true, spvNavn: spv.navn });
      });
      await new Promise(r => setTimeout(r, 250));
    }

    // 3) hent koordinater for alle kommuner
    const kommuneKart = {};
    const kommuner = [...new Set(alleDoffin.map(d => d.kommune).filter(Boolean))];
    for (const k of kommuner) {
      const pos = await hentKoordinater(k);
      if (pos) kommuneKart[k] = pos;
    }

    const doffinBygg = alleDoffin.filter(d => d.harBygg).sort((a, b) => b.score - a.score);
    const aktivitet  = doffinBygg.length;

    process.stdout.write(` Doffin:${doffinBygg.length} SPV:${spvListe.length}\n`);

    resultat[s.id] = {
      navn: s.navn, kategori: s.kategori,
      oppdatert: new Date().toISOString().slice(0, 10),
      aktivitet,
      doffin: doffinBygg.slice(0, 12),
      spv: spvListe.slice(0, 15).map(sp => ({ navn: sp.navn, org: sp.org, kommune: sp.kommuneNavn })),
      kommuneKart,
      nyheter: [{
        tittel: `Søk nyheter om ${s.navn}`,
        lenke: `https://news.google.com/search?q=${encodeURIComponent(s.nyhetsord)}&hl=no&gl=NO&ceid=NO:no`,
        erLenke: true
      }]
    };
  }

  fs.writeFileSync('konkurrenter-data.json',
    JSON.stringify({ _oppdatert: new Date().toISOString().slice(0, 10), selskaper: resultat }, null, 1),
    'utf8');

  console.log('\n===== OPPSUMMERING =====');
  const aktive = Object.values(resultat).filter(s => s.aktivitet > 0);
  console.log(`Aktive (Doffin): ${aktive.length} av ${selskaper.length}`);
  const spvRike = Object.values(resultat).filter(s => s.spv && s.spv.length > 0);
  console.log(`Med SPV-er:      ${spvRike.length} av ${selskaper.length}`);
  aktive.sort((a, b) => b.aktivitet - a.aktivitet).slice(0, 8)
    .forEach(s => console.log(`  ${s.aktivitet.toString().padStart(3)}  ${s.navn} (${s.spv.length} SPV-er)`));
  console.log('\nSkrevet: konkurrenter-data.json');
})();
