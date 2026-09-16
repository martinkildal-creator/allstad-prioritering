/**
 * lag-signaler.js
 * Lager signaler.json som appen (index.html) leser.
 *
 * Kjør:  node lag-signaler.js
 *
 * Henter:
 *   1) Doffin  – aktive kunngjøringer om omsorgsboliger/sykehjem (åpent API)
 *   2) Husbanken – leses fra husbanken.csv hvis fila finnes (Husbanken har ikke API)
 *
 * Skriver: signaler.json  (samme mappe)
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------
// INNSTILLINGER – juster her
// ---------------------------------------------------------------
const SOKEORD = [
  'omsorgsbolig', 'omsorgsboliger', 'sykehjem', 'helsehus',
  'bofellesskap', 'heldøgns', 'omsorgssenter', 'bokollektiv',
  'demenslandsby', 'eldreboliger'
];

// Poeng per type kunngjøring
const POENG = { konkurranse: 12, veiledende: 8, tildeling: 4, annet: 3 };
const MAKS_DOFFIN = 20;      // tak på doffinScore per kommune
const POENG_PER_TILSAGN = 6; // Husbanken
const MAKS_HUSBANK = 15;

const DOFFIN_BASE = process.env.DOFFIN_BASE || 'https://api.doffin.no/public/v2';
const DOFFIN_KEY  = process.env.DOFFIN_API_KEY || '';   // settes som hemmelighet, se guiden

// ---------------------------------------------------------------
// Hjelpere
// ---------------------------------------------------------------
const norm = s => (s || '').toString().toLowerCase().trim();

/** Doffin leverer ofte felt som objekt ({no:"..."}) eller liste. Gjør om til ren tekst. */
function tekstAv(v, dybde = 0) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (dybde > 3) return '';
  if (Array.isArray(v)) return v.map(x => tekstAv(x, dybde + 1)).filter(Boolean).join(' ');
  if (typeof v === 'object') {
    // foretrekk norsk/engelsk tekstfelt hvis de finnes
    for (const k of ['no', 'nb', 'nn', 'nor', 'en', 'value', 'text', 'name', 'label']) {
      if (v[k] != null) return tekstAv(v[k], dybde + 1);
    }
    return Object.values(v).map(x => tekstAv(x, dybde + 1)).filter(Boolean).join(' ');
  }
  return '';
}

/** Finner "Elverum kommune" -> "elverum" i en tekst */
function finnKommune(raa) {
  const tekst = tekstAv(raa);
  if (!tekst) return null;
  const m = tekst.match(/([A-Za-zÆØÅæøåÄÖäö\-\s]{2,40}?)\s+kommune/i);
  if (!m) return null;
  let navn = m[1].trim();
  // fjern ord som ofte henger foran
  navn = navn.replace(/^(i|for|til|hos|av|fra|ved|og)\s+/i, '').trim();
  // hvis flere ord, ta det siste (f.eks. "Innkjøpstjenesten Elverum" -> "Elverum")
  if (/\s/.test(navn)) {
    const deler = navn.split(/\s+/);
    navn = deler[deler.length - 1];
  }
  if (navn.length < 2 || navn.length > 30) return null;
  return norm(navn);
}

function typeAvKunngjoring(t) {
  const s = norm(t);
  if (/konkurranse|contract notice|cn/.test(s)) return 'konkurranse';
  if (/veiledende|prior information|pin|market/.test(s)) return 'veiledende';
  if (/tildeling|award|can/.test(s)) return 'tildeling';
  return 'annet';
}

function datoKort(d) {
  if (!d) return null;
  const s = d.toString();
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

function belopKort(v) {
  if (v == null || v === '') return null;
  // kan komme som {amount: 185000000, currency:"NOK"} eller som tekst
  if (typeof v === 'object') v = v.amount ?? v.value ?? tekstAv(v);
  let s = v.toString().replace(/[^\d.,]/g, '').trim();
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/,/g) || []).length === 1) s = s.replace(',', '.');
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' mill. kr';
  return Math.round(n).toLocaleString('no') + ' kr';
}

// ---------------------------------------------------------------
// 1) DOFFIN
// ---------------------------------------------------------------
async function hentDoffin() {
  const treffPerKommune = {};
  let totalt = 0;

  for (const ord of SOKEORD) {
    const url = `${DOFFIN_BASE}/search?searchString=${encodeURIComponent(ord)}`
              + `&numHitsPerPage=100&page=1`;
    try {
      const headers = { 'Accept': 'application/json' };
      if (DOFFIN_KEY) headers['Ocp-Apim-Subscription-Key'] = DOFFIN_KEY;

      const r = await fetch(url, { headers });
      if (!r.ok) {
        console.warn(`  ! Doffin svarte ${r.status} for "${ord}"`);
        if (r.status === 401 || r.status === 403) {
          console.warn('    (Trenger trolig API-nøkkel – se guiden, punkt 3)');
        }
        continue;
      }
      const j = await r.json();
      const liste = j.hits || j.results || j.notices || j.items || j.value || [];
      if (!Array.isArray(liste)) { console.warn(`  ! Uventet svarformat for "${ord}"`); continue; }

      // Diagnose: skriv ut feltnavnene fra første kunngjøring vi ser (bare én gang)
      if (!global.__visteFelt && liste.length) {
        global.__visteFelt = true;
        console.log('  [diagnose] felt i kunngjøring:', Object.keys(liste[0]).join(', '));
        console.log('  [diagnose] eksempel:', JSON.stringify(liste[0]).slice(0, 400));
      }

      liste.forEach(n => {
       try {
        const tittel  = tekstAv(n.heading || n.title || n.noticeTitle || n.name);
        const kjoper  = tekstAv(n.buyerName || n.buyer || n.organisationName || n.contractingAuthority || n.organization);
        const typeRaa = tekstAv(n.noticeType || n.type || n.formType);
        const frist   = n.deadline || n.submissionDeadline || n.tenderDeadline || null;
        const publ    = n.publicationDate || n.published || n.publishedDate || null;
        const verdi   = n.estimatedValue || n.value || n.estimatedValueAmount || null;
        const id      = tekstAv(n.id || n.noticeId || n.doffinId || n.identifier);

        // bare nyere kunngjøringer (siste 18 mnd)
        if (publ) {
          const p = new Date(tekstAv(publ));
          const grense = new Date(); grense.setMonth(grense.getMonth() - 18);
          if (isFinite(p) && p < grense) return;
        }

        const kommune = finnKommune(kjoper) || finnKommune(tittel);
        if (!kommune) return;

        // relevanssjekk: søkeordet skal faktisk finnes i tittel/tekst
        const tekst = norm(tittel + ' ' + tekstAv(n.description || n.shortDescription));
        if (!SOKEORD.some(o => tekst.includes(norm(o)))) return;

        const type = typeAvKunngjoring(typeRaa || tittel);
        if (!treffPerKommune[kommune]) treffPerKommune[kommune] = [];
        // unngå duplikater
        if (id && treffPerKommune[kommune].some(x => x._id === id)) return;

        treffPerKommune[kommune].push({
          _id: id,
          type: type === 'konkurranse' ? 'Konkurranse'
              : type === 'veiledende'  ? 'Veiledende kunngjøring'
              : type === 'tildeling'   ? 'Tildeling' : 'Kunngjøring',
          tittel: tittel.slice(0, 160),
          frist: datoKort(tekstAv(frist)),
          verdi: belopKort(verdi),
          url: id ? `https://www.doffin.no/notices/${id}` : null
        });
        totalt++;
       } catch (e) { /* hopp over kunngjøringer vi ikke klarer å tolke */ }
      });

      await new Promise(res => setTimeout(res, 400)); // vær grei mot API-et
    } catch (e) {
      console.warn(`  ! Feil ved "${ord}": ${e.message}`);
    }
  }
  console.log(`  Doffin: ${totalt} relevante treff i ${Object.keys(treffPerKommune).length} kommuner.`);
  return treffPerKommune;
}

// ---------------------------------------------------------------
// 2) HUSBANKEN (fra husbanken.csv – lastes ned manuelt, se guiden)
//    Forventet format (semikolon eller komma), med overskriftsrad:
//    kommune;tilsagn;plasser;belop
// ---------------------------------------------------------------
function lesHusbanken() {
  const fil = path.join(__dirname, 'husbanken.csv');
  if (!fs.existsSync(fil)) {
    console.log('  Husbanken: husbanken.csv ikke funnet – hopper over.');
    return {};
  }
  const tekst = fs.readFileSync(fil, 'utf8');
  const linjer = tekst.split(/\r?\n/).filter(l => l.trim());
  if (linjer.length < 2) return {};

  const skille = linjer[0].includes(';') ? ';' : ',';
  const hode = linjer[0].split(skille).map(s => norm(s));
  const iKom = hode.findIndex(h => /kommune|region/.test(h));
  const iTil = hode.findIndex(h => /tilsagn|antall|saker/.test(h));
  const iPla = hode.findIndex(h => /plass|enhet|bolig/.test(h));
  const iBel = hode.findIndex(h => /bel(ø|o)p|kroner|tilskudd|sum/.test(h));
  if (iKom < 0) { console.warn('  ! husbanken.csv: fant ingen kommune-kolonne.'); return {}; }

  const ut = {};
  linjer.slice(1).forEach(l => {
    const c = l.split(skille);
    let kom = norm(c[iKom]).replace(/\s+kommune$/, '').replace(/^\d+\s*/, '');
    if (!kom) return;
    const tall = v => { const n = Number((v || '').toString().replace(/[^\d,.-]/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
    const tilsagn = iTil >= 0 ? tall(c[iTil]) : 1;
    if (!tilsagn) return;
    if (!ut[kom]) ut[kom] = { tilsagn: 0, plasser: 0, belop: 0 };
    ut[kom].tilsagn += tilsagn;
    if (iPla >= 0) ut[kom].plasser += tall(c[iPla]);
    if (iBel >= 0) ut[kom].belop   += tall(c[iBel]);
  });
  console.log(`  Husbanken: ${Object.keys(ut).length} kommuner fra husbanken.csv.`);
  return ut;
}

// ---------------------------------------------------------------
// Sett sammen og skriv fil
// ---------------------------------------------------------------
(async () => {
  console.log('Lager signaler.json ...');
  const doffin = await hentDoffin();
  const husbank = lesHusbanken();

  const kommuner = {};
  const alle = new Set([...Object.keys(doffin), ...Object.keys(husbank)]);

  alle.forEach(k => {
    const treff = (doffin[k] || []).map(t => { const { _id, ...rest } = t; return rest; });
    let dScore = 0;
    treff.forEach(t => {
      const ty = typeAvKunngjoring(t.type);
      dScore += POENG[ty] || POENG.annet;
    });
    dScore = Math.min(MAKS_DOFFIN, dScore);

    const hb = husbank[k] || null;
    const hScore = hb ? Math.min(MAKS_HUSBANK, Math.round(hb.tilsagn * POENG_PER_TILSAGN)) : 0;

    kommuner[k] = {
      doffinScore: dScore,
      husbankScore: hScore,
      doffinTreff: treff,
      husbankTilsagn: hb ? hb.tilsagn : 0,
      husbankDetalj: hb ? {
        tilsagn: hb.tilsagn,
        plasser: hb.plasser || null,
        belop: hb.belop ? belopKort(hb.belop) : null,
        status: 'Investeringstilskudd'
      } : null
    };
  });

  const ut = {
    _oppdatert: new Date().toISOString().slice(0, 10),
    _kilder: 'Doffin (åpne kunngjøringer) og Husbankens statistikkbank (manuell csv)',
    kommuner
  };

  fs.writeFileSync(path.join(__dirname, 'signaler.json'), JSON.stringify(ut, null, 1), 'utf8');
  console.log(`Ferdig: signaler.json med ${Object.keys(kommuner).length} kommuner.`);
})();
