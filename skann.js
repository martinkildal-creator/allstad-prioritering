/**
 * skann.js – leser politiske saksdokumenter i kommunene
 *
 * Bruker portaler.json (fra kartlegg.js) som utgangspunkt, følger seg fram til
 * møtekalender/sakslister, og flagger saker som handler om omsorgsbygg.
 * Fungerer på tvers av ACOS, Prokom, Elements og Public 360 fordi den kjenner
 * igjen SIDENE på innholdet, ikke på adressen.
 *
 * Kjør:  node skann.js
 * Test:  ANTALL=15 node skann.js
 */

const fs = require('fs');

const ANTALL  = Number(process.env.ANTALL || 0);   // 0 = alle
const PAUSE   = Number(process.env.PAUSE || 250);
const TIMEOUT = 12000;
const MAKS_SIDER = 4;      // hvor mange sider vi åpner per kommune

// Saker vi leter etter
const NOKKELORD = [
  'omsorgsbolig', 'omsorgsboliger', 'sykehjem', 'helsehus', 'bofellesskap',
  'heldøgns', 'heldogns', 'omsorgssenter', 'eldrebolig', 'eldreboliger',
  'demenslandsby', 'bo- og behandlingssenter', 'bo- og servicesenter',
  'helse- og omsorgsplan', 'omsorgsplan', 'boligbehov', 'boligsosial',
  'sykehjemsstruktur', 'eldreomsorg', 'leve hele livet', 'omsorgstrapp',
  'institusjonsplasser', 'botilbud eldre'
];

// Sterke signaler (vektes høyere)
const STERKE = [
  'omsorgsbolig', 'omsorgsboliger', 'sykehjem', 'helsehus',
  'helse- og omsorgsplan', 'boligbehov', 'sykehjemsstruktur', 'omsorgssenter'
];

// Slik kjenner vi igjen en møte-/sakslisteside
const MOTEORD = [
  'saksliste', 'møtedato', 'motedato', 'møteplan', 'moteplan', 'møteinnkalling',
  'moteinnkalling', 'formannskap', 'kommunestyre', 'utvalg', 'møtebok',
  'motebok', 'protokoll', 'møtekalender', 'motekalender', 'saksframlegg',
  'saksfremlegg'
];

// Lenker vi gjerne følger videre
const FOLGORD = [
  'møtekalender', 'motekalender', 'møteplan', 'moteplan', 'saksliste',
  'formannskap', 'kommunestyre', 'møter', 'moter', 'utvalg', 'politiske',
  'innsyn', 'møtedokumenter', 'motedokumenter', 'saksdokumenter'
];

const norm = s => (s || '').toString().toLowerCase();

async function hent(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Allstad-saksskanner/1.0 (intern analyse av offentlige dokumenter)' }
    });
    if (!r.ok) return null;
    const ct = norm(r.headers.get('content-type') || '');
    if (!ct.includes('html')) return null;
    return { url: r.url, html: (await r.text()).slice(0, 600000) };
  } catch { return null; }
  finally { clearTimeout(t); }
}

const stripp = html => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

function erMoteside(tekst) {
  const t = norm(tekst);
  return MOTEORD.filter(o => t.includes(o)).length >= 2;
}

/** Finn lenker verdt å følge */
function lenker(html, basis) {
  const ut = []; const sett = new Set();
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,140}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && ut.length < 500) {
    const tekst = norm(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const samlet = tekst + ' ' + norm(m[1]);
    if (!FOLGORD.some(o => samlet.includes(o))) continue;
    let full; try { full = new URL(m[1], basis).href; } catch { continue; }
    if (!/^https?:/.test(full) || sett.has(full)) continue;
    if (/\.(pdf|docx?|xlsx?|zip|jpg|png)$/i.test(full)) continue;
    sett.add(full);
    // prioriter tydelige møtesider
    const vekt = /saksliste|m(ø|o)teplan|m(ø|o)tekalender|kommunestyre|formannskap/.test(samlet) ? 0 : 1;
    ut.push({ url: full, vekt });
  }
  return ut.sort((a, b) => a.vekt - b.vekt).slice(0, 6);
}

/** Finn setninger som nevner nøkkelordene */
function finnTreff(tekst) {
  const t = norm(tekst);
  const funn = [];
  for (const ord of NOKKELORD) {
    let i = t.indexOf(ord);
    while (i >= 0 && funn.length < 12) {
      const fra = Math.max(0, i - 90), til = Math.min(tekst.length, i + ord.length + 110);
      let utdrag = tekst.slice(fra, til).trim().replace(/\s+/g, ' ');
      if (utdrag.length > 30) {
        funn.push({ ord, utdrag: (fra > 0 ? '…' : '') + utdrag + (til < tekst.length ? '…' : '') });
      }
      i = t.indexOf(ord, i + ord.length);
      if (funn.filter(f => f.ord === ord).length >= 2) break;  // maks 2 per ord
    }
  }
  // fjern nesten like utdrag
  const unike = []; const sett = new Set();
  for (const f of funn) {
    const n = f.utdrag.slice(0, 60);
    if (sett.has(n)) continue;
    sett.add(n); unike.push(f);
  }
  return unike.slice(0, 8);
}

(async () => {
  if (!fs.existsSync('portaler.json')) {
    console.error('Fant ikke portaler.json – kjør kartlegg.js først.');
    process.exit(1);
  }
  const portaler = JSON.parse(fs.readFileSync('portaler.json', 'utf8')).kommuner || {};
  let liste = Object.entries(portaler).filter(([, v]) => v.portal);
  console.log(`Skanner saksdokumenter i ${liste.length} kommuner ...`);
  if (ANTALL) liste = liste.slice(0, ANTALL);

  const resultat = {};
  let medTreff = 0, sider = 0, feilet = 0;

  for (let i = 0; i < liste.length; i++) {
    const [nokkel, k] = liste[i];
    const besokt = new Set();
    const treff = [];
    let ko = [{ url: k.portal, vekt: 0 }];

    for (let s = 0; s < MAKS_SIDER && ko.length; s++) {
      const neste = ko.shift();
      if (besokt.has(neste.url)) { s--; continue; }
      besokt.add(neste.url);

      const side = await hent(neste.url);
      sider++;
      if (!side) { feilet++; continue; }

      const tekst = stripp(side.html);

      if (erMoteside(tekst)) {
        finnTreff(tekst).forEach(f => {
          if (treff.some(x => x.utdrag.slice(0, 50) === f.utdrag.slice(0, 50))) return;
          treff.push({ ...f, url: side.url });
        });
      }
      // følg videre bare hvis vi ikke har nok treff
      if (treff.length < 4) {
        lenker(side.html, side.url).forEach(l => { if (!besokt.has(l.url)) ko.push(l); });
        ko.sort((a, b) => a.vekt - b.vekt);
      }
      await new Promise(r => setTimeout(r, 150));
    }

    if (treff.length) {
      const sterke = treff.filter(t => STERKE.includes(t.ord)).length;
      resultat[nokkel] = {
        navn: k.navn, nr: k.nr, plattform: k.plattform,
        poeng: Math.min(10, sterke * 3 + (treff.length - sterke)),
        treff: treff.slice(0, 6)
      };
      medTreff++;
    }

    if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${liste.length}  (treff i ${medTreff})`);
    await new Promise(r => setTimeout(r, PAUSE));
  }

  fs.writeFileSync('politikk.json', JSON.stringify({
    _oppdatert: new Date().toISOString().slice(0, 10),
    _kilde: 'Kommunale møtekalendere og sakslister (offentlige dokumenter)',
    kommuner: resultat
  }, null, 1), 'utf8');

  console.log('\n===== RESULTAT =====');
  console.log(`Kommuner med treff:  ${medTreff} av ${liste.length}`);
  console.log(`Sider lest:          ${sider}  (${feilet} feilet)`);
  const topp = Object.values(resultat).sort((a, b) => b.poeng - a.poeng).slice(0, 8);
  console.log('\nSterkeste treff:');
  topp.forEach(t => console.log(`  ${t.poeng.toString().padStart(2)}  ${t.navn}: ${(t.treff[0] || {}).utdrag || ''}`.slice(0, 150)));
  console.log('\nSkrevet: politikk.json');
})();
