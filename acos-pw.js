/**
 * acos-pw.js – søker i ACOS Innsyn Pluss (uten nettleser, via ASP.NET-postback).
 *
 * Portalen er en ASP.NET-side: søket sendes som POST tilbake til samme side,
 * med de skjulte feltene (__VIEWSTATE osv.) som siden selv la ut.
 * Vi henter siden, plukker feltene, og sender søket.
 *
 * Test én kommune:  MODUS=lab SLUG=lund node acos-post.js
 * Finn slug-er:     MODUS=slug node acos-post.js
 * Skann alle:       MODUS=skann node acos-post.js
 */

const fs = require('fs');

const MODUS  = process.env.MODUS || 'lab';
const SLUG   = process.env.SLUG || 'lund';
const ANTALL = Number(process.env.ANTALL || 0);
const PAUSE  = Number(process.env.PAUSE || 400);

const SOKEORD = (process.env.ORD || 'omsorgsbolig,sykehjem,omsorgssenter,helsehus,boligbehov').split(',');
const STERKE = ['omsorgsbolig', 'omsorgsboliger', 'sykehjem', 'helsehus', 'omsorgssenter', 'boligbehov'];

const norm = s => (s || '').toString().toLowerCase();
const base = s => `https://innsynpluss.onacos.no/${s}/sok/`;

async function hent(url, opsjoner = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      ...opsjoner, redirect: 'follow', signal: ctrl.signal,
      headers: {
        'User-Agent': 'Allstad-analyse/1.0 (offentlige moetedokumenter)',
        'Accept': 'text/html,application/xhtml+xml',
        ...(opsjoner.headers || {})
      }
    });
    const satt = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
    const cookies = satt.map(c => c.split(';')[0]).join('; ');
    return { ok: r.ok, status: r.status, url: r.url, cookies, html: (await r.text()).slice(0, 900000) };
  } catch (e) {
    return { ok: false, status: 0, url, html: '', feil: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

/** Plukk ut alle skjulte felt ASP.NET krever */
function skjulteFelt(html) {
  const felt = {};
  const re = /<input[^>]+type=["']hidden["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const n = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    const v = (tag.match(/value=["']([^"']*)["']/i) || [])[1] || '';
    if (n) felt[n] = v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  return felt;
}

/** Finn navnet på søkefeltet og søkeknappen */
function sokeFelt(html) {
  const txt = (html.match(/name=["']([^"']*txtSearch[^"']*)["']/i) || [])[1];
  const btn = (html.match(/name=["']([^"']*btnSearch[^"']*)["']/i) || [])[1];
  return { txt, btn };
}

const stripp = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** Treffene står som lenker til sak/dokument */
function trekkTreff(html, ord) {
  const ut = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{5,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && ut.length < 60) {
    const tittel = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (tittel.length < 12) continue;
    if (!norm(tittel).includes(norm(ord))) continue;
    let url; try { url = new URL(m[1].replace(/&amp;/g, '&'), 'https://innsynpluss.onacos.no').href; } catch { continue; }
    if (ut.some(x => x.tittel === tittel)) continue;
    ut.push({ tittel: tittel.slice(0, 200), url });
  }
  return ut;
}

/** Utfør ett søk mot én kommune */
async function sok(slug, ord, diag = false) {
  const forside = await hent(base(slug));
  if (!forside.ok) return { feil: `status ${forside.status}` };
  if (/brukernavn eller e-post|acos cms/i.test(stripp(forside.html)) && forside.html.length < 20000)
    return { feil: 'ikke innsynsportal (feil slug?)' };

  const felt = skjulteFelt(forside.html);
  const { txt, btn } = sokeFelt(forside.html);
  if (!txt) return { feil: 'fant ikke søkefeltet' };

  // ASP.NET krever ofte økt-cookien fra GET-en
  const cookie = forside.cookies || '';

  const lagKropp = variant => {
    const kr = new URLSearchParams();
    Object.entries(felt).forEach(([k, v]) => kr.append(k, v));
    kr.set(txt, ord);
    if (variant === 'knapp') {
      kr.set('__EVENTTARGET', '');
      kr.set('__EVENTARGUMENT', '');
      if (btn) kr.set(btn, 'Søk');
    } else {           // variant 'event': knappen som hendelse
      kr.set('__EVENTTARGET', (btn || txt).replace(/\$/g, '$'));
      kr.set('__EVENTARGUMENT', '');
      if (btn) kr.delete(btn);
    }
    return kr.toString();
  };

  let svar = null;
  for (const variant of ['knapp', 'event']) {
    svar = await hent(base(slug), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': base(slug),
        'Origin': 'https://innsynpluss.onacos.no',
        'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8',
        ...(cookie ? { 'Cookie': cookie } : {})
      },
      body: lagKropp(variant)
    });
    if (diag) console.log(`    variant "${variant}": status ${svar.status}, ${svar.html.length} tegn${cookie ? ', cookie sendt' : ', INGEN cookie'}`);
    if (svar.ok) break;
    if (diag && svar.html) console.log(`      serverfeil: ${stripp(svar.html).slice(0, 180)}`);
  }
  if (!svar || !svar.ok) return { feil: `POST ga ${svar ? svar.status : '?'}` };

  const tekst = stripp(svar.html);
  const treff = trekkTreff(svar.html, ord);
  if (diag) {
    console.log(`    skjulte felt: ${Object.keys(felt).length}, søkefelt: ${txt ? 'ja' : 'nei'}, knapp: ${btn ? 'ja' : 'nei'}`);
    console.log(`    svar: ${svar.html.length} tegn, tekst nevner søkeordet: ${norm(tekst).includes(norm(ord)) ? 'JA' : 'nei'}`);
    console.log(`    utdrag: ${tekst.slice(0, 260)}`);
  }
  return { treff, nevner: norm(tekst).includes(norm(ord)), lengde: svar.html.length };
}

(async () => {
  // ---------- LAB ----------
  if (MODUS === 'lab') {
    console.log(`=== LAB (uten nettleser): ${SLUG} ===\n`);
    for (const ord of SOKEORD.slice(0, 2)) {
      console.log(`  Søker etter "${ord}":`);
      const r = await sok(SLUG, ord, true);
      if (r.feil) { console.log(`    FEIL: ${r.feil}\n`); continue; }
      console.log(`    treff funnet: ${r.treff.length}`);
      r.treff.slice(0, 6).forEach(t => console.log(`      • ${t.tittel.slice(0, 110)}`));
      console.log('');
      await new Promise(r2 => setTimeout(r2, PAUSE));
    }
    return;
  }

  // ---------- FINN SLUG-ER ----------
  if (MODUS === 'slug') {
    const alle = JSON.parse(fs.readFileSync('portaler.json', 'utf8')).kommuner || {};
    const kart = {}; let funnet = 0, i = 0;
    const liste = Object.entries(alle);
    for (const [nokkel, k] of liste) {
      i++;
      // 1) står slug-en allerede i en kjent lenke?
      const kilder = [k.portal, ...(k.alternativer || []), k.nettsted].filter(Boolean);
      let slug = null;
      for (const u of kilder) {
        const m = u.match(/innsynpluss\.onacos\.no\/([^/?#]+)/i);
        if (m) { slug = m[1]; break; }
      }
      // 2) ellers: let etter lenken på kommunens nettsted
      if (!slug && k.nettsted) {
        const r = await hent(k.nettsted);
        if (r.ok) {
          const m = r.html.match(/innsynpluss\.onacos\.no\/([a-z0-9\-]+)/i);
          if (m) slug = m[1];
        }
        await new Promise(r2 => setTimeout(r2, 150));
      }
      if (slug) { kart[nokkel] = { navn: k.navn, nr: k.nr, slug }; funnet++; }
      if (i % 50 === 0) console.log(`  ... ${i}/${liste.length} (slug funnet: ${funnet})`);
    }
    fs.writeFileSync('acos-slugger.json', JSON.stringify({ _oppdatert: new Date().toISOString().slice(0, 10), kommuner: kart }, null, 1));
    console.log(`\nSlug funnet for ${funnet} kommuner. Skrevet: acos-slugger.json`);
    return;
  }

  // ---------- SKANN ----------
  const kilde = fs.existsSync('acos-slugger.json')
    ? JSON.parse(fs.readFileSync('acos-slugger.json', 'utf8')).kommuner
    : {};
  let liste = Object.entries(kilde);
  if (!liste.length) { console.error('Mangler acos-slugger.json – kjør MODUS=slug først.'); process.exit(1); }
  if (ANTALL) liste = liste.slice(0, ANTALL);
  console.log(`Søker i ${liste.length} ACOS-kommuner ...`);

  const resultat = {}; let medTreff = 0, totalt = 0, feil = 0;
  for (let i = 0; i < liste.length; i++) {
    const [nokkel, k] = liste[i];
    const samlet = [];
    for (const ord of SOKEORD) {
      const r = await sok(k.slug, ord);
      if (r.feil) { feil++; break; }
      r.treff.forEach(t => {
        if (samlet.some(x => x.tittel === t.tittel)) return;
        samlet.push({ ord, tittel: t.tittel, url: t.url });
      });
      await new Promise(r2 => setTimeout(r2, PAUSE));
    }
    if (samlet.length) {
      const sterke = samlet.filter(t => STERKE.includes(t.ord)).length;
      resultat[nokkel] = {
        navn: k.navn, nr: k.nr, plattform: 'ACOS Innsyn',
        poeng: Math.min(10, sterke * 2 + samlet.length),
        treff: samlet.slice(0, 8)
      };
      medTreff++; totalt += samlet.length;
      console.log(`  ✓ ${k.navn}: ${samlet.length} treff – ${samlet[0].tittel.slice(0, 80)}`);
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
  console.log(`Feilet:             ${feil}`);
  console.log('Skrevet: politikk-acos.json');
})();
