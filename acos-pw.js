/**
 * acos-pw.js – ACOS Innsyn med EKTE NETTLESER (Playwright)
 *
 * Forskjellen fra tidligere forsøk: her kjøres JavaScript, så vi ser det
 * samme som et menneske ser. Det var dette som manglet.
 *
 * Sonde:  node acos-pw.js               (tester 10 kommuner, viser hva som finnes)
 * Skann:  MODUS=skann ANTALL=0 node acos-pw.js
 */

const fs = require('fs');
const { chromium } = require('playwright');

const MODUS  = process.env.MODUS || 'sonde';
const ANTALL = Number(process.env.ANTALL || (MODUS === 'sonde' ? 10 : 0));
const MOTER_PER_KOMMUNE = Number(process.env.MOTER || 8);
const DIAG = process.env.DIAG !== '0';

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

const slugAv = navn => norm(navn)
  .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
  .replace(/[^a-z0-9]/g, '');

function finnSaker(tekst) {
  SAKSNR.lastIndex = 0;
  const pos = []; let m;
  while ((m = SAKSNR.exec(tekst)) && pos.length < 600)
    pos.push({ nr: m[1].replace(/\s+/g, ''), start: m.index, etter: m.index + m[0].length });
  const ut = [];
  for (let i = 0; i < pos.length; i++) {
    const slutt = i + 1 < pos.length ? pos[i + 1].start : Math.min(tekst.length, pos[i].etter + 200);
    const tittel = tekst.slice(pos[i].etter, slutt).trim().replace(/^[-–:.\s]+/, '').slice(0, 200);
    if (tittel.length >= 8) ut.push({ nr: pos[i].nr, tittel });
  }
  return ut;
}

/** Hent ACOS-kommuner: bruk slug fra lenke hvis den finnes, ellers gjett fra navnet */
function acosKommuner(alle) {
  const ut = [];
  for (const [nokkel, k] of Object.entries(alle)) {
    const kilder = [k.portal, ...(k.alternativer || [])].filter(Boolean);
    const medSlug = kilder.find(u => /onacos\.no\/[^/?#]+/i.test(u));
    let slug = null;
    if (medSlug) {
      const m = medSlug.match(/onacos\.no\/([^/?#]+)/i);
      if (m) slug = m[1].replace(/-(byggesaker|planer|postliste)$/i, '');
    }
    const erAcos = /ACOS/i.test(k.plattform || '') || medSlug;
    if (!erAcos) continue;
    ut.push({ nokkel, navn: k.navn, nr: k.nr, slug: slug || slugAv(k.navn), gjettet: !slug });
  }
  return ut;
}

const URL_MOTEPLAN = s => `https://innsynpluss.onacos.no/${s}/wfinnsyn.ashx?response=moteplan`;
const INNGANGER = s => [
  `https://innsynpluss.onacos.no/${s}/sok/`,
  `https://innsynpluss.onacos.no/${s}/moter/`,
  `https://innsynpluss.onacos.no/${s}/motekalender/`,
  `https://innsynpluss.onacos.no/${s}/politiskemoter/`,
  `https://innsynpluss.onacos.no/${s}/wfinnsyn.ashx?response=moteplan`
];

async function sideTekst(page, url, ventTekst) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    // vent til JavaScript har lagt inn innholdet
    try {
      await page.waitForFunction(
        () => document.body && document.body.innerText.replace(/\s+/g, ' ').length > 400,
        { timeout: 12000 });
    } catch { /* fortsett med det vi har */ }
    if (ventTekst) { try { await page.waitForTimeout(1200); } catch {} }
    return await page.evaluate(() => document.body ? document.body.innerText.replace(/\s+/g, ' ') : '');
  } catch (e) { return ''; }
}

/** Finn lenker til enkeltmøter (sakslister) på møteplan-siden */
async function moteLenker(page) {
  try {
    return await page.evaluate(() => Array.from(document.querySelectorAll('a'))
      .map(a => a.href)
      .filter(h => /sakliste|saksliste|mote_?detalj|moteid|mid=/i.test(h))
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 40));
  } catch { return []; }
}

(async () => {
  if (!fs.existsSync('portaler.json')) { console.error('Mangler portaler.json'); process.exit(1); }
  const alle = JSON.parse(fs.readFileSync('portaler.json', 'utf8')).kommuner || {};
  let liste = acosKommuner(alle);
  console.log(`ACOS-kommuner: ${liste.length} (${liste.filter(k => k.gjettet).length} med gjettet adresse)`);
  if (ANTALL) liste = liste.slice(0, ANTALL);

  const nettleser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await nettleser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; Allstad-analyse/1.0; offentlige moetedokumenter)',
    viewport: { width: 1280, height: 900 }
  });
  const page = await ctx.newPage();
  // ikke last bilder/fonter - raskere og snillere
  await page.route('**/*', r => ['image', 'font', 'media'].includes(r.request().resourceType())
    ? r.abort() : r.continue());

  const resultat = {};
  let medTreff = 0, sakerLest = 0, medMoteplan = 0, sider = 0;

  for (let i = 0; i < liste.length; i++) {
    const k = liste[i];
    const url = URL_MOTEPLAN(k.slug);
    const tekst = await sideTekst(page, url, true);
    sider++;
    const harMoteplan = /m(ø|o)te|utvalg|dato/i.test(tekst) && tekst.length > 300;
    if (harMoteplan) medMoteplan++;

    const lenker = harMoteplan ? await moteLenker(page) : [];
    if (DIAG) console.log(`  [${k.navn}] tegn=${tekst.length} møteplan=${harMoteplan ? 'JA' : 'nei'} møtelenker=${lenker.length}${k.gjettet ? ' (gjettet)' : ''}`);

    if (MODUS === 'sonde') {
      console.log(`      [moteplan] tekst: ${tekst.slice(0, 150) || '(tom)'}`);
      for (const u of INNGANGER(k.slug)) {
        if (u === url) continue;
        const t2 = await sideTekst(page, u, true);
        sider++;
        const l2 = await moteLenker(page);
        console.log(`      ${u.replace('https://innsynpluss.onacos.no/' + k.slug, '…')}`);
        console.log(`         tegn=${t2.length} lenker=${l2.length} :: ${t2.slice(0, 130) || '(tom)'}`);
        if (l2.length) console.log(`         eksempel: ${l2[0]}`);
      }
      continue;
    }

    let brukteLenker = lenker;
    if (!brukteLenker.length) {
      for (const u of INNGANGER(k.slug)) {
        if (u === url) continue;
        await sideTekst(page, u, true); sider++;
        const l2 = await moteLenker(page);
        if (l2.length) { brukteLenker = l2; break; }
      }
    }

    const treff = [];
    for (const l of brukteLenker.slice(0, MOTER_PER_KOMMUNE)) {
      const t = await sideTekst(page, l, true);
      sider++;
      const saker = finnSaker(t);
      if (!saker.length) continue;
      sakerLest += saker.length;
      saker.forEach(sk => {
        const ord = NOKKELORD.find(o => norm(sk.tittel).includes(o));
        if (!ord) return;
        const u = `${sk.nr} ${sk.tittel}`;
        if (treff.some(x => x.utdrag.slice(0, 40) === u.slice(0, 40))) return;
        treff.push({ ord, utdrag: u, url: l });
      });
      if (treff.length >= 6) break;
    }

    if (treff.length) {
      const sterke = treff.filter(t => STERKE.includes(t.ord)).length;
      resultat[k.nokkel] = {
        navn: k.navn, nr: k.nr, plattform: 'ACOS Innsyn',
        poeng: Math.min(10, sterke * 3 + (treff.length - sterke)),
        treff: treff.slice(0, 6)
      };
      medTreff++;
      console.log(`  ✓ ${k.navn}: ${treff[0].utdrag.slice(0, 90)}`);
    }
    if ((i + 1) % 25 === 0) console.log(`  ... ${i + 1}/${liste.length} (treff i ${medTreff})`);
  }

  await nettleser.close();

  if (MODUS === 'skann') {
    fs.writeFileSync('politikk-acos.json', JSON.stringify({
      _oppdatert: new Date().toISOString().slice(0, 10),
      _kilde: 'ACOS Innsyn – kommunale møteplaner og sakslister',
      kommuner: resultat
    }, null, 1), 'utf8');
  }

  console.log('\n===== RESULTAT =====');
  console.log(`Kommuner med møteplan: ${medMoteplan} av ${liste.length}`);
  if (MODUS === 'skann') {
    console.log(`Kommuner med treff:    ${medTreff}`);
    console.log(`Politiske saker lest:  ${sakerLest}`);
    console.log('Skrevet: politikk-acos.json');
  } else {
    console.log('Sonde ferdig. Gir dette møtelenker, kjør MODUS=skann.');
  }
  console.log(`Sider lest: ${sider}`);
})();
