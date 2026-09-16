/**
 * kartlegg.js  –  SPEIDER (kjøres én gang, ikke ukentlig)
 *
 * Finner ut hvor hver kommune publiserer politiske møter (formannskap,
 * kommunestyre) og hvilken plattform de bruker. Skriver portaler.json,
 * som senere brukes av selve skanneren.
 *
 * Kjør:  node kartlegg.js
 * Kjør et utvalg først:  ANTALL=25 node kartlegg.js
 */

const fs = require('fs');

const ANTALL = Number(process.env.ANTALL || 0);     // 0 = alle
const PAUSE = Number(process.env.PAUSE || 250);     // ms mellom kall (vær grei)
const TIMEOUT = 12000;

// Ord som avslører en møtekalender-lenke
const LENKEORD = [
  'møtekalender', 'motekalender', 'politiske møter', 'politiske moter',
  'møteplan', 'moteplan', 'innsyn', 'politikk', 'møter og saksdokumenter',
  'saksdokumenter', 'politisk møtekalender'
];

// Fingeravtrykk: tekst i HTML/URL -> plattform
const PLATTFORM = [
  ['360online.com',        'Public 360 (opengov)'],
  ['opengov',              'Public 360 (opengov)'],
  ['acos',                 'ACOS Innsyn'],
  ['elementscloud',        'Elements (Sikri)'],
  ['sikri',                'Elements (Sikri)'],
  ['einnsyn.no',           'eInnsyn'],
  ['websak',               'ACOS WebSak'],
  ['compilo',              'Compilo'],
  ['prokom',               'Prokom'],
  ['tieto',                'Tieto//Evry'],
  ['innsyn.onacos',        'ACOS Innsyn']
];

const slug = s => s.toLowerCase()
  .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
  .replace(/[^a-z0-9]/g, '');

async function hent(url, metode = 'GET') {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      method: metode,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Allstad-kommunekartlegging/1.0 (intern analyse)' }
    });
    const tekst = metode === 'GET' ? (await r.text()).slice(0, 400000) : '';
    return { ok: r.ok, status: r.status, url: r.url, tekst };
  } catch (e) {
    return { ok: false, status: 0, url, tekst: '', feil: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

/** Hent kommuneliste fra SSBs KLASS (samme kilde som appen) */
/** Offisielle nettadresser fra Enhetsregisteret (Brønnøysund) – slår gjetting */
async function hentNettsteder() {
  const kart = {};
  for (let side = 0; side < 5; side++) {
    const u = 'https://data.brreg.no/enhetsregisteret/api/enheter'
            + `?organisasjonsform=KOMM&size=200&page=${side}`;
    const r = await hent(u);
    if (!r.ok) { console.warn('  ! Brreg svarte ' + r.status); break; }
    let j; try { j = JSON.parse(r.tekst); } catch { break; }
    const liste = (j._embedded && j._embedded.enheter) || [];
    if (!liste.length) break;
    liste.forEach(e => {
      const navn = (e.navn || '').replace(/\s+KOMMUNE$/i, '').trim();
      let hj = (e.hjemmeside || '').trim();
      if (!hj) return;
      if (!/^https?:\/\//i.test(hj)) hj = 'https://' + hj;
      kart[slug(navn)] = hj;
    });
    await new Promise(res => setTimeout(res, 200));
  }
  console.log(`  ${Object.keys(kart).length} nettadresser fra Enhetsregisteret.`);
  return kart;
}

async function hentKommuner() {
  const r = await hent('https://data.ssb.no/api/klass/v1/classifications/131/codesAt?date=' +
                       new Date().toISOString().slice(0, 10));
  if (!r.ok) throw new Error('Fikk ikke kommunelisten fra SSB: ' + r.status);
  const j = JSON.parse(r.tekst);
  return (j.codes || [])
    .filter(c => /^\d{4}$/.test(c.code) && c.code !== '9999')
    .map(c => ({ nr: c.code, navn: c.name.replace(/ - .*$/, '').trim() }));
}

function finnPlattform(...tekster) {
  const alt = tekster.join(' ').toLowerCase();
  for (const [nokkel, navn] of PLATTFORM) if (alt.includes(nokkel)) return navn;
  return null;
}

/** Plukk ut lenker som ser ut som møtekalender */
function finnMoteLenker(html, basis) {
  const ut = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && ut.length < 400) {
    const href = m[1];
    const tekst = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
    const samlet = (tekst + ' ' + href).toLowerCase();
    if (!LENKEORD.some(o => samlet.includes(o))) continue;
    let full;
    try { full = new URL(href, basis).href; } catch { continue; }
    if (!/^https?:/.test(full)) continue;
    // ranger: eksterne portaler først, så "møtekalender", så "innsyn"
    let vekt = 3;
    if (/360online|acos|elementscloud|einnsyn|opengov/i.test(full)) vekt = 0;
    else if (/m(ø|o)tekalender|m(ø|o)teplan|politiske/i.test(samlet)) vekt = 1;
    else if (/saksdokument/i.test(samlet)) vekt = 2;
    ut.push({ url: full, tekst, vekt });
  }
  ut.sort((a, b) => a.vekt - b.vekt);
  // fjern duplikater
  const sett = new Set(); const unike = [];
  for (const l of ut) { if (sett.has(l.url)) continue; sett.add(l.url); unike.push(l); }
  return unike.slice(0, 4);
}

(async () => {
  console.log('Kartlegger kommunale møteportaler ...');
  let kommuner = await hentKommuner();
  console.log(`  ${kommuner.length} kommuner hentet fra SSB KLASS.`);
  const nettsteder = await hentNettsteder();
  if (ANTALL) kommuner = kommuner.slice(0, ANTALL);

  const resultat = {};
  const tell = { funnet: 0, forsideFeil: 0, ingenLenke: 0 };
  const plattformTell = {};

  for (let i = 0; i < kommuner.length; i++) {
    const k = kommuner[i];
    const s = slug(k.navn);
    const kandidater = [
      nettsteder[s],                          // offisiell adresse fra Enhetsregisteret
      `https://www.${s}.kommune.no/`,
      `https://${s}.kommune.no/`,
      `https://www.${s}.no/`
    ].filter(Boolean);

    let forside = null;
    for (const u of kandidater) {
      const r = await hent(u);
      if (r.ok && r.tekst.length > 500) { forside = r; break; }
      await new Promise(res => setTimeout(res, 120));
    }

    if (!forside) {
      resultat[s] = { navn: k.navn, nr: k.nr, status: 'fant ikke nettside' };
      tell.forsideFeil++;
    } else {
      const lenker = finnMoteLenker(forside.tekst, forside.url);
      let plattform = finnPlattform(forside.tekst, ...lenker.map(l => l.url));
      let portal = lenker[0] ? lenker[0].url : null;

      // åpne den beste lenken for å fingeravtrykke plattformen
      if (portal && !plattform) {
        const r2 = await hent(portal);
        if (r2.ok) plattform = finnPlattform(r2.url, r2.tekst);
        if (r2.ok) portal = r2.url;
      }

      resultat[s] = {
        navn: k.navn, nr: k.nr,
        nettsted: forside.url,
        portal, plattform: plattform || 'ukjent',
        alternativer: lenker.slice(1).map(l => l.url),
        status: portal ? 'ok' : 'ingen møtelenke funnet'
      };
      if (portal) tell.funnet++; else tell.ingenLenke++;
      const p = plattform || 'ukjent';
      plattformTell[p] = (plattformTell[p] || 0) + 1;
    }

    if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${kommuner.length}`);
    await new Promise(res => setTimeout(res, PAUSE));
  }

  fs.writeFileSync('portaler.json',
    JSON.stringify({ _oppdatert: new Date().toISOString().slice(0, 10), kommuner: resultat }, null, 1), 'utf8');

  console.log('\n===== RESULTAT =====');
  console.log(`Møteportal funnet:      ${tell.funnet}`);
  console.log(`Ingen møtelenke:        ${tell.ingenLenke}`);
  console.log(`Fant ikke nettside:     ${tell.forsideFeil}`);
  console.log('\nPlattformer:');
  Object.entries(plattformTell).sort((a, b) => b[1] - a[1])
    .forEach(([p, n]) => console.log(`  ${n.toString().padStart(4)}  ${p}`));
  console.log('\nSkrevet: portaler.json');
})();
