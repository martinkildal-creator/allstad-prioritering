/**
 * sok-api.js – søker i ACOS Innsyn Pluss via API-et vi fant.
 *
 *   GET  /{slug}/sok/                     -> økt-cookie
 *   POST /api/presentation/v2/nye-innsyn/overviewInit
 *   POST /api/presentation/v2/nye-innsyn/overview   {searchTerm: "omsorgsbolig"}
 *
 * Standard: tester Lund og viser hva API-et svarer.
 * MODUS=slug  -> finner portal-adressen (slug) for alle kommuner
 * MODUS=skann -> søker i alle kommuner, skriver politikk-acos.json
 */

const fs = require('fs');

const MODUS  = (process.env.MODUS || '').trim() || 'lab';
const SLUG   = (process.env.SLUG  || '').trim() || 'lund';
const ANTALL = Number(process.env.ANTALL || 0);
const PAUSE  = Number(process.env.PAUSE || 350);

const SOKEORD = (process.env.ORD || 'omsorgsbolig,sykehjem,omsorgssenter,helsehus,boligbehov')
  .split(',').map(s => s.trim()).filter(Boolean);
const STERKE = ['omsorgsbolig', 'sykehjem', 'helsehus', 'omsorgssenter', 'boligbehov'];

const VERT = 'https://innsynpluss.onacos.no';
const API  = `${VERT}/api/presentation/v2/nye-innsyn`;
const norm = s => (s || '').toString().toLowerCase();

async function kall(url, opsjoner = {}, cookie = '') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, {
      ...opsjoner, redirect: 'follow', signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Allstad-analyse/1.0)',
        'Accept': opsjoner.method === 'POST' ? 'application/json, text/plain, */*' : 'text/html',
        ...(opsjoner.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(opsjoner.headers || {})
      }
    });
    const satt = r.headers.getSetCookie ? r.headers.getSetCookie()
               : [r.headers.get('set-cookie')].filter(Boolean);
    return {
      ok: r.ok, status: r.status,
      cookies: satt.map(c => c.split(';')[0]).join('; '),
      tekst: (await r.text()).slice(0, 1500000)
    };
  } catch (e) {
    return { ok: false, status: 0, cookies: '', tekst: '', feil: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

/** Ett søk mot én kommune */
async function sok(slug, ord, diag = false) {
  const side = await kall(`${VERT}/${slug}/sok/`);
  if (!side.ok) return { feil: `portal ga ${side.status}` };
  if (/brukernavn eller e-post/i.test(side.tekst) && side.tekst.length < 20000)
    return { feil: 'ikke innsynsportal (feil adresse)' };
  const cookie = side.cookies;

  // API-et vil ha en "init" først
  await kall(`${API}/overviewInit`, {
    method: 'POST',
    body: JSON.stringify({ keyValues: [], type: 0 }),
    headers: { Referer: `${VERT}/${slug}/sok/`, Origin: VERT }
  }, cookie);

  const svar = await kall(`${API}/overview`, {
    method: 'POST',
    body: JSON.stringify({
      type: 0,
      keyValues: [
        { key: 'searchTerm', value: ord },
        { key: 'titleSearch', value: '' },
        { key: 'caseDocIDSearch', value: '' },
        { key: 'farmPropertyNumberSearch', value: '' },
        { key: 'senderRecipientSearch', value: '' },
        { key: 'page', value: '1' }
      ]
    }),
    headers: { Referer: `${VERT}/${slug}/sok/`, Origin: VERT }
  }, cookie);

  if (!svar.ok) return { feil: `API ga ${svar.status}` };

  let data = null;
  try { data = JSON.parse(svar.tekst); } catch { return { feil: 'svaret var ikke JSON', raatekst: svar.tekst.slice(0, 300) }; }

  if (diag) {
    console.log(`    API svarte ${svar.status}, ${svar.tekst.length} tegn`);
    console.log(`    toppnivå-felt: ${Object.keys(data).join(', ')}`);
    console.log(`    utdrag: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return { data, treff: hentTreff(data, ord) };
}

// Dokumenttyper som er politisk relevante
const GODE_TYPER = ['saksframlegg', 'sakskart', 'møteprotokoll', 'moteprotokoll', 'sak', 'utgående dokument'];

// Ren støy fra postjournalen
const STOY = [
  'st. ref', 'søknad og cv', 'arbeidsavtale', 'vikariat', 'stilling', 'tilsetting',
  'ansettelse', 'lønn', 'permisjon', 'sykmeld', 'oppsigelse', 'attest', 'cv',
  'ferdigattest', 'brukstillatelse', 'igangsettingstillatelse', 'ansiennitet',
  'taushetserklæring', 'politiattest', 'arbeidsforhold', 'turnus', 'time- og',
  'faktura', 'purring', 'egenandel', 'klage på vedtak', 'pasientjournal'
];

// Ord som gjør en sak interessant selv om typen er et vanlig dokument
const STERKT_SIGNAL = /utredning|utbygging|planlegging|prosjekt|byggetrinn|detaljregulering|reguleringsplan|forprosjekt|mulighetsstudie|investering|helse- ?og ?omsorgsplan|boligplan|boligbehov|sykehjemsstruktur|nytt sykehjem|nye omsorgsbolig|bygging av/i;

/** Finn titler i svaret, uansett hvordan det er bygget opp */
function hentTreff(data, ord) {
  const ut = [];

  // 1) Bruk den strukturerte listen hvis den finnes
  const poster = data && data.content && data.content.searchItems && data.content.searchItems.items;
  if (Array.isArray(poster)) {
    poster.forEach(it => {
      const tittel = (it.title || '').replace(/\s+/g, ' ').trim();
      if (tittel.length < 10) return;
      if (!norm(tittel).includes(norm(ord))) return;
      const t = norm(tittel);
      if (STOY.some(o => t.includes(o))) return;                       // fjern personal- og byggesakstøy
      const type = norm(it.type || '');
      const relevantType = GODE_TYPER.some(g => type.includes(g));
      if (!relevantType && !STERKT_SIGNAL.test(tittel)) return;        // krev politisk type ELLER sterkt signal
      if (ut.some(x => x.tittel === tittel)) return;
      const pr = it.properties || {};
      ut.push({
        tittel: tittel.slice(0, 200),
        type: it.type || null,
        dato: pr.dato || null,
        saksnr: pr.dokumentID || pr.saksID || null,
        id: it.identifier ? String(it.identifier).slice(0, 80) : null
      });
    });
    return ut.slice(0, 20);
  }

  const se = (obj, dybde = 0) => {
    if (!obj || dybde > 6 || ut.length > 60) return;
    if (Array.isArray(obj)) { obj.forEach(o => se(o, dybde + 1)); return; }
    if (typeof obj !== 'object') return;
    // et objekt med tittel-aktig felt = et treff
    const tittelNokkel = Object.keys(obj).find(k => /^(title|tittel|heading|name|subject|caseTitle|documentTitle)$/i.test(k));
    if (tittelNokkel && typeof obj[tittelNokkel] === 'string' && obj[tittelNokkel].length > 8) {
      const tittel = obj[tittelNokkel].replace(/\s+/g, ' ').trim();
      const id = Object.entries(obj).find(([k]) => /(^id$|caseId|docId|documentId|guid)/i.test(k));
      if (norm(tittel).includes(norm(ord)) && !ut.some(x => x.tittel === tittel)) {
        ut.push({ tittel: tittel.slice(0, 200), id: id ? String(id[1]).slice(0, 60) : null });
      }
    }
    Object.values(obj).forEach(v => se(v, dybde + 1));
  };
  se(data);
  return ut;
}

(async () => {
  // ---------- LAB ----------
  if (MODUS === 'lab') {
    console.log(`=== API-TEST: ${SLUG} ===\n`);
    for (const ord of SOKEORD.slice(0, 2)) {
      console.log(`  Søker etter "${ord}":`);
      const r = await sok(SLUG, ord, true);
      if (r.feil) { console.log(`    FEIL: ${r.feil}`); if (r.raatekst) console.log(`    ${r.raatekst}`); console.log(''); continue; }
      console.log(`    TREFF: ${r.treff.length}`);
      r.treff.slice(0, 8).forEach(t => console.log(`      • [${t.type || '?'}${t.dato ? ' ' + t.dato : ''}] ${t.tittel.slice(0, 110)}`));
      console.log('');
      await new Promise(s => setTimeout(s, PAUSE));
    }
    return;
  }

  // ---------- FINN ADRESSER ----------
  if (MODUS === 'slug') {
    const alle = JSON.parse(fs.readFileSync('portaler.json', 'utf8')).kommuner || {};
    const kart = {}; let i = 0, funnet = 0;
    for (const [nokkel, k] of Object.entries(alle)) {
      i++;
      let slug = null;
      for (const u of [k.portal, ...(k.alternativer || []), k.nettsted].filter(Boolean)) {
        const m = u.match(/innsynpluss\.onacos\.no\/([a-z0-9\-]+)/i);
        if (m) { slug = m[1]; break; }
      }
      if (!slug && k.nettsted) {
        const r = await kall(k.nettsted);
        const m = r.tekst.match(/innsynpluss\.onacos\.no\/([a-z0-9\-]+)/i);
        if (m) slug = m[1];
        await new Promise(s => setTimeout(s, 120));
      }
      if (slug) { kart[nokkel] = { navn: k.navn, nr: k.nr, slug }; funnet++; }
      if (i % 50 === 0) console.log(`  ... ${i} (funnet ${funnet})`);
    }
    fs.writeFileSync('acos-slugger.json', JSON.stringify({ _oppdatert: new Date().toISOString().slice(0, 10), kommuner: kart }, null, 1));
    console.log(`\nAdresse funnet for ${funnet} kommuner. Skrevet: acos-slugger.json`);
    return;
  }

  // ---------- SKANN ----------
  if (!fs.existsSync('acos-slugger.json')) { console.error('Kjør MODUS=slug først.'); process.exit(1); }
  let liste = Object.entries(JSON.parse(fs.readFileSync('acos-slugger.json', 'utf8')).kommuner);
  if (ANTALL) liste = liste.slice(0, ANTALL);
  console.log(`Søker i ${liste.length} kommuner ...`);

  const resultat = {}; let medTreff = 0, totalt = 0, feilet = 0;
  for (let i = 0; i < liste.length; i++) {
    const [nokkel, k] = liste[i];
    const samlet = [];
    for (const ord of SOKEORD) {
      const r = await sok(k.slug, ord);
      if (r.feil) { feilet++; break; }
      r.treff.forEach(t => {
        if (samlet.some(x => x.tittel === t.tittel)) return;
        samlet.push({ ord, tittel: t.tittel, type: t.type, dato: t.dato, saksnr: t.saksnr,
          url: `${VERT}/${k.slug}/sok/#/?searchTerm=${encodeURIComponent(ord)}` });
      });
      await new Promise(s => setTimeout(s, PAUSE));
    }
    if (samlet.length) {
      const sterke = samlet.filter(t => STERKE.includes(t.ord)).length;
      resultat[nokkel] = {
        navn: k.navn, nr: k.nr, plattform: 'ACOS Innsyn',
        poeng: Math.min(10, sterke * 2 + samlet.length),
        treff: samlet.slice(0, 8)
      };
      medTreff++; totalt += samlet.length;
      console.log(`  ✓ ${k.navn}: ${samlet.length} – ${samlet[0].tittel.slice(0, 80)}`);
    }
    if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${liste.length} (treff i ${medTreff})`);
  }

  fs.writeFileSync('politikk-acos.json', JSON.stringify({
    _oppdatert: new Date().toISOString().slice(0, 10),
    _kilde: 'ACOS Innsyn Pluss – søk i saker og dokumenter',
    kommuner: resultat
  }, null, 1), 'utf8');

  console.log('\n===== RESULTAT =====');
  console.log(`Kommuner med treff: ${medTreff} av ${liste.length}`);
  console.log(`Treff totalt:       ${totalt}`);
  console.log(`Feilet:             ${feilet}`);
  console.log('Skrevet: politikk-acos.json');
})();
