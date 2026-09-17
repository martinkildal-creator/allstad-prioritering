/**
 * fang.js – finner ut hvordan søket i ACOS Innsyn Pluss faktisk fungerer.
 * Ingen innstillinger. Bare kjør.
 */

const { chromium } = require('playwright');

const SLUG = 'lund';
const ORD  = 'omsorgsbolig';
const URL  = `https://innsynpluss.onacos.no/${SLUG}/sok/`;

(async () => {
  console.log(`=== FANG v2 ===`);
  console.log(`Portal: ${URL}`);
  console.log(`Søkeord: ${ORD}\n`);

  const nb = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await nb.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const kall = [];
  page.on('request', r => {
    const t = r.resourceType();
    if (t === 'xhr' || t === 'fetch' || r.method() === 'POST') {
      kall.push({ m: r.method(), u: r.url(), d: (r.postData() || '').slice(0, 500) });
    }
  });
  page.on('response', async r => {
    const u = r.url();
    if (/api|search|sok|query|solr|elastic/i.test(u) && !/\.(png|jpg|svg|css|woff2?|js)(\?|$)/i.test(u)) {
      kall.push({ m: 'SVAR ' + r.status(), u, d: '' });
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);

  // 1) finn søkefeltet, også inne i web-komponenter
  const info = await page.evaluate(() => {
    const funnet = [];
    const let_ = (rot, dybde = 0) => {
      if (dybde > 8 || !rot) return;
      if (rot.querySelectorAll) {
        rot.querySelectorAll('input').forEach(e => {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && ['search', 'text'].includes(e.type)) {
            funnet.push({ type: e.type, ph: e.placeholder || '', dybde });
          }
        });
        rot.querySelectorAll('*').forEach(e => { if (e.shadowRoot) let_(e.shadowRoot, dybde + 1); });
      }
    };
    let_(document);
    return funnet;
  });
  console.log(`Synlige søkefelt funnet: ${info.length}`);
  info.forEach(f => console.log(`  type=${f.type} placeholder="${f.ph}" (dybde ${f.dybde})`));

  // 2) skriv i feltet som et menneske
  let skrevet = false;
  try {
    const felt = page.locator('input[type="search"]').first();
    await felt.waitFor({ state: 'attached', timeout: 8000 });
    await felt.fill(ORD, { force: true, timeout: 8000 });
    await felt.press('Enter');
    skrevet = true;
  } catch (e) {
    console.log(`  (fill feilet: ${e.message.split('\n')[0].slice(0, 80)})`);
  }

  // 3) hvis det ikke gikk: sett verdien direkte
  if (!skrevet) {
    skrevet = await page.evaluate((ord) => {
      const finn = (rot, d = 0) => {
        if (d > 8 || !rot || !rot.querySelector) return null;
        const t = rot.querySelector('input[type="search"], input[placeholder*="Søk" i], input[placeholder*="leter" i]');
        if (t) return t;
        for (const el of rot.querySelectorAll('*')) {
          if (el.shadowRoot) { const f = finn(el.shadowRoot, d + 1); if (f) return f; }
        }
        return null;
      };
      const f = finn(document);
      if (!f) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(f, ord);
      ['input', 'change'].forEach(n => f.dispatchEvent(new Event(n, { bubbles: true, composed: true })));
      f.focus();
      ['keydown', 'keypress', 'keyup'].forEach(n =>
        f.dispatchEvent(new KeyboardEvent(n, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true })));
      const skjema = f.closest && f.closest('form');
      if (skjema) { try { skjema.requestSubmit ? skjema.requestSubmit() : skjema.submit(); } catch (e) {} }
      return true;
    }, ORD);
    console.log(`  satte verdien direkte: ${skrevet ? 'JA' : 'NEI'}`);
  }

  // 4) prøv også å klikke en søkeknapp
  try {
    const knapp = page.locator('button:has-text("Søk"), input[type="submit"]').first();
    if (await knapp.count()) { await knapp.click({ force: true, timeout: 5000 }); }
  } catch {}

  await page.waitForTimeout(7000);

  const tekst = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  console.log(`\nURL etter søk: ${page.url()}`);
  console.log(`Nevner søkeordet: ${tekst.toLowerCase().includes(ORD) ? 'JA' : 'nei'}`);
  console.log(`Tekst: ${tekst.slice(0, 400)}\n`);

  const unike = [];
  const sett = new Set();
  kall.forEach(k => { const n = k.m + k.u; if (!sett.has(n)) { sett.add(n); unike.push(k); } });

  console.log(`FORESPØRSLER (${unike.length}):`);
  unike.slice(-25).forEach(k => {
    console.log(`  ${k.m}  ${k.u.slice(0, 170)}`);
    if (k.d) console.log(`        data: ${k.d.slice(0, 250)}`);
  });

  await nb.close();
})();
