/**
 * acos.js – går rett på ACOS-portalene i stedet for å navigere nettsider.
 *
 * FASE 1 (sonde):   node acos.js            -> tester adressemønstre, rapporterer hva som svarer
 * FASE 2 (skann):   MODUS=skann node acos.js -> bruker det som virker, skriver politikk-acos.json
 *
 * Slug hentes fra portal-adressen i portaler.json, f.eks.
 *   https://innsynpluss.onacos.no/nes/sok/          -> "nes"
 *   https://innsyn.onacos.no/forsand/wfinnsyn.ashx  -> "forsand"
 */

const fs = require('fs');

const MODUS   = process.env.MODUS || 'sonde';
const ANTALL  = Number(process.env.ANTALL || (MODUS === 'sonde' ? 12 : 0));
const PAUSE   = Number(process.env.PAUSE || 200);
const TIMEOUT = 12000;

const NOKKELORD = [
  'omsorgsbolig', 'omsorgsboliger', 'sykehjem', 'helsehus', 'bofellesskap',
  'heldøgns', 'heldogns', 'omsorgssenter', 'eldrebolig', 'eldreboliger',
  'demenslandsby', 'bo- og behandlingssenter', 'bo- og servicesenter',
  'helse- og omsorgsplan', 'omsorgsplan', 'boligbehov', 'boligsosial',
  'sykehjemsstruktur', 'eldreomsorg', 'institusjonsplasser'
];
const STERKE = ['omsorgsbolig', 'omsorgsboliger', 'sykehjem', 'helsehus',
                'helse- og omsorgsplan', 'boligbehov', 'sykehjemsstruktur', 'omsorgssenter'];

const norm = s => (s || '').toString().toLowerCase();
const SAKSNR = /\b(?:PS|RS|DS|FO|SAK)\s*(\d{1,4}\s*\/\s*\d{2,4})\b/gi;

/** Adressemønstre vi tester, i prioritert rekkefølge */
function kandidater(slug) {
  const k = [];
  // klassisk ACOS (server-generert HTML - det vi håper på)
  ['innsyn.onacos.no', 'innsynpluss.onacos.no'].forEach(vert => {
    ['moteplan', 'mote_utvalg', 'mote_sakliste'].forEach(r => {
      k.push(`https://${vert}/${slug}/wfinnsyn.ashx?response=${r}`);
    });
  });
  // eldre variant uten wfinnsyn
  k.push(`https://innsyn.onacos.no/${slug}/innsyn.aspx?response=moteplan`);
  return k;
}

async function hent(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'Allstad-analyse/1.0 (offentlige moetedokumenter)' }
    });
    const tekst = (await r.text()).slice(0, 500000);
    return { status: r.status, ok: r.ok, url: r.url, html: tekst };
  } catch (e) {
    return { status: 0, ok: false, url, html: '', feil: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

const stripp = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

function tellSaker(tekst) {
  SAKSNR.lastIndex = 0;
  let n = 0;
  while (SAKSNR.exec(tekst) && n < 999) n++;
  return n;
}

function finnSaker(tekst) {
  SAKSNR.lastIndex = 0;
  const pos = []; let m;
  while ((m = SAKSNR.exec(tekst)) && pos.length < 500)
    pos.push({ nr: m[1].replace(/\s+/g, ''), etter: m.index + m[0].length, start: m.index });
  const ut = [];
  for (let i = 0; i < pos.length; i++) {
    const slutt = i + 1 < pos.length ? pos[i + 1].start : Math.min(tekst.length, pos[i].etter + 180);
    const tittel = tekst.slice(pos[i].etter, slutt).trim().replace(/^[-–:.\s]+/, '').slice(0, 180);
    if (tittel.length >= 8) ut.push({ nr: pos[i].nr, tittel });
  }
  return ut;
}

/** Lenker til enkeltmøter inne i en ACOS-møteplan */
function moteLenker(html, basis) {
  const ut = []; const sett = new Set();
  const re = /href=["']([^"']*(?:wfinnsyn|innsyn)\.(?:ashx|aspx)[^"'#]*)["']/gi;
  let m;
  while ((m = re.exec(html)) && ut.length < 25) {
    let full; try { full = new URL(m[1].replace(/&amp;/g, '&'), basis).href; } catch { continue; }
    if (sett.has(full)) continue;
    if (!/mote|sakliste|saksliste/i.test(full)) continue;
    sett.add(full); ut.push(full);
  }
  return ut;
}

(async () => {
  if (!fs.existsSync('portaler.json')) { console.error('Mangler portaler.json'); process.exit(1); }
  const alle = JSON.parse(fs.readFileSync('portaler.json', 'utf8')).kommuner || {};

  // finn ACOS-kommuner og slug
  let acos = [];
  for (const [nokkel, k] of Object.entries(alle)) {
    const kilder = [k.portal, ...(k.alternativer || [])].filter(Boolean);
    const treff = kilder.find(u => /onacos\.no/i.test(u));
    if (!treff) continue;
    const m = treff.match(/onacos\.no\/([^/?#]+)/i);
    if (!m) continue;
    let slug = m[1].replace(/-byggesaker$|-planer$/i, '');
    acos.push({ nokkel, navn: k.navn, nr: k.nr, slug });
  }
  console.log(`ACOS-kommuner funnet i portaler.json: ${acos.length}`);
  if (ANTALL) acos = acos.slice(0, ANTALL);

  if (MODUS === 'sonde') {
    console.log(`\nSonderer ${acos.length} kommuner ...\n`);
    const virker = {};
    for (const k of acos) {
      for (const u of kandidater(k.slug)) {
        const r = await hent(u);
        const tekst = stripp(r.html);
        const saker = tellSaker(tekst);
        const mote = /m(ø|o)teplan|m(ø|o)tedato|utvalg|saksliste/i.test(tekst);
        const merke = saker > 0 ? 'SAKER!' : (mote ? 'møteside' : (r.ok ? 'ok' : 'nei'));
        console.log(`  [${k.navn}] ${merke.padEnd(9)} ${r.status}  tegn=${tekst.length}  saker=${saker}`);
        console.log(`      ${u}`);
        if (saker > 0 || mote) {
          const monster = u.replace(k.slug, '{slug}');
          virker[monster] = (virker[monster] || 0) + 1;
        }
        await new Promise(res => setTimeout(res, PAUSE));
      }
    }
    console.log('\n===== MØNSTRE SOM SVARTE =====');
    const sortert = Object.entries(virker).sort((a, b) => b[1] - a[1]);
    if (!sortert.length) console.log('  Ingen av mønstrene svarte med innhold.');
    sortert.forEach(([m, n]) => console.log(`  ${n.toString().padStart(3)}  ${m}`));
    console.log('\nKjør med MODUS=skann når et mønster gir SAKER.');
    return;
  }

  // ---- SKANN ----
  const resultat = {}; let medTreff = 0, sakerLest = 0, sider = 0;
  for (let i = 0; i < acos.length; i++) {
    const k = acos[i];
    const treff = [];
    let planHtml = null, planUrl = null;

    for (const u of kandidater(k.slug)) {
      const r = await hent(u); sider++;
      if (!r.ok) continue;
      const tekst = stripp(r.html);
      if (tellSaker(tekst) > 0) {
        finnSaker(tekst).forEach(sk => {
          const ord = NOKKELORD.find(o => norm(sk.tittel).includes(o));
          if (ord) treff.push({ ord, utdrag: `${sk.nr} ${sk.tittel}`, url: r.url });
        });
        sakerLest += tellSaker(tekst);
      }
      if (!planHtml && /m(ø|o)teplan|utvalg/i.test(tekst)) { planHtml = r.html; planUrl = r.url; }
      await new Promise(res => setTimeout(res, PAUSE));
    }

    // åpne enkeltmøter fra møteplanen
    if (planHtml && treff.length < 6) {
      for (const u of moteLenker(planHtml, planUrl).slice(0, 12)) {
        const r = await hent(u); sider++;
        if (!r.ok) continue;
        const tekst = stripp(r.html);
        const n = tellSaker(tekst);
        if (!n) continue;
        sakerLest += n;
        finnSaker(tekst).forEach(sk => {
          const ord = NOKKELORD.find(o => norm(sk.tittel).includes(o));
          if (!ord) return;
          if (treff.some(t => t.utdrag.slice(0, 40) === `${sk.nr} ${sk.tittel}`.slice(0, 40))) return;
          treff.push({ ord, utdrag: `${sk.nr} ${sk.tittel}`, url: r.url });
        });
        await new Promise(res => setTimeout(res, PAUSE));
      }
    }

    if (treff.length) {
      const sterke = treff.filter(t => STERKE.includes(t.ord)).length;
      resultat[k.nokkel] = {
        navn: k.navn, nr: k.nr, plattform: 'ACOS Innsyn',
        poeng: Math.min(10, sterke * 3 + (treff.length - sterke)),
        treff: treff.slice(0, 6)
      };
      medTreff++;
    }
    if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${acos.length} (treff i ${medTreff})`);
  }

  fs.writeFileSync('politikk-acos.json', JSON.stringify({
    _oppdatert: new Date().toISOString().slice(0, 10),
    _kilde: 'ACOS Innsyn - kommunale møteplaner og sakslister',
    kommuner: resultat
  }, null, 1), 'utf8');

  console.log('\n===== RESULTAT =====');
  console.log(`Kommuner med treff:   ${medTreff} av ${acos.length}`);
  console.log(`Politiske saker lest: ${sakerLest}`);
  console.log(`Sider lest:           ${sider}`);
  Object.values(resultat).sort((a, b) => b.poeng - a.poeng).slice(0, 10)
    .forEach(t => console.log(`  ${t.poeng.toString().padStart(2)}  ${t.navn}: ${t.treff[0].utdrag}`.slice(0, 150)));
  console.log('\nSkrevet: politikk-acos.json');
})();
