/**
 * konkurrenter.js – overvåker konkurrenter via Doffin og Google News
 *
 * Kjøres ukentlig av GitHub Actions (mandag 07:00).
 * Leser: konkurrenter.json
 * Skriver: konkurrenter-data.json
 */

const fs = require('fs');

const DOFFIN_KEY = process.env.DOFFIN_API_KEY || '';
const DOFFIN_BASE = 'https://api.doffin.no/public/v2';
const PAUSE = Number(process.env.PAUSE || 400);

const norm = s => (s || '').toString().toLowerCase();

// ---- Hjelpere ----
async function hent(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      ...opts, redirect: 'follow', signal: ctrl.signal,
      headers: {
        'User-Agent': 'Allstad-konkurransemonitor/1.0',
        'Accept': opts.json ? 'application/json' : 'text/html,application/xml',
        ...(opts.headers || {})
      }
    });
    const tekst = (await r.text()).slice(0, 800000);
    return { ok: r.ok, status: r.status, tekst };
  } catch (e) {
    return { ok: false, status: 0, tekst: '', feil: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

// ---- Doffin: søk etter konkurrent i kunngjøringer ----
const DOFFIN_BYGGTYPE = [
  'omsorgsbolig', 'sykehjem', 'helsehus', 'bofellesskap',
  'omsorgssenter', 'eldrebolig', 'aldershjem', 'bo- og behandlingssenter'
];

async function søkDoffin(selskap) {
  const funn = [];
  for (const søkeord of selskap.søkeord) {
    const headers = { Accept: 'application/json' };
    if (DOFFIN_KEY) headers['Ocp-Apim-Subscription-Key'] = DOFFIN_KEY;
    const r = await hent(
      `${DOFFIN_BASE}/search?searchString=${encodeURIComponent(søkeord)}&numHitsPerPage=50&page=1`,
      { json: true, headers }
    );
    if (!r.ok) { console.warn(`  ! Doffin ${r.status} for "${søkeord}"`); continue; }
    let j; try { j = JSON.parse(r.tekst); } catch { continue; }
    const liste = j.hits || j.results || j.notices || j.items || j.value || [];

    for (const n of liste) {
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

      const tittel = tekstAv(n.heading || n.title || n.name || '');
      const kjoper = tekstAv(n.buyer || n.organisationName || '');
      const besk   = tekstAv(n.description || n.shortDescription || '');
      const type   = tekstAv(n.type || n.noticeType || '');
      const samlet = norm(tittel + ' ' + kjoper + ' ' + besk);

      // Finn om det handler om omsorgsbygg
      const harBygg = DOFFIN_BYGGTYPE.some(o => samlet.includes(o));

      // Er konkurrenten nevnt i kjøper, tittel eller beskriv?
      const navnTreff = selskap.søkeord.some(s => samlet.includes(norm(s)));

      if (!navnTreff) continue;

      const erTildeling = /tildeling|award|contract award/i.test(type + ' ' + tittel);
      const erBygg      = harBygg;

      // Regn ut relevans
      const score = (erTildeling ? 3 : 0) + (erBygg ? 2 : 0) + (navnTreff ? 1 : 0);

      const pub  = tekstAv(n.publicationDate || n.issueDate || '');
      const frist = tekstAv(n.deadline || n.submissionDeadline || '');
      const id    = tekstAv(n.id || n.noticeId || '');
      const url   = tekstAv(n.doffinClassicUrl || (id ? `https://www.doffin.no/notices/${id}` : ''));

      const dup = funn.some(x => x.id === id && id);
      if (!dup) funn.push({
        id, tittel: tittel.slice(0, 200), kjoper: kjoper.slice(0, 100),
        type: erTildeling ? 'Tildeling' : 'Kunngjøring',
        dato: (pub || '').slice(0, 10),
        frist: (frist || '').slice(0, 10),
        harBygg, erTildeling, score, url
      });
    }
    await new Promise(r => setTimeout(r, PAUSE));
  }
  // sorter: tildeling + bygg øverst, nyeste dato
  funn.sort((a, b) => (b.score - a.score) || (b.dato || '').localeCompare(a.dato || ''));
  return funn.slice(0, 20);
}

// ---- Google News RSS ----
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 6) {
    const get = (tag) => {
      const t = new RegExp(`<${tag}[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/${tag}>`, 'is').exec(m[1]);
      return t ? t[1].trim() : '';
    };
    const tittel = get('title').replace(/<[^>]+>/g, '').trim();
    const lenke  = get('link') || get('guid');
    const dato   = get('pubDate');
    const kilde  = get('source') || (get('dc:creator') || '');
    if (tittel && lenke) items.push({ tittel: tittel.slice(0, 200), lenke, dato: dato.slice(0, 30), kilde });
  }
  return items;
}

async function søkNyheter(selskap) {
  // Prøv flere RSS-kilder som faktisk virker fra GitHub Actions
  const urls = [
    // Bing News RSS (fungerer fra servere)
    `https://www.bing.com/news/search?q=${encodeURIComponent(selskap.nyhetsord)}&format=rss`,
    // DuckDuckGo nyhetssøk
    `https://duckduckgo.com/?q=${encodeURIComponent(selskap.nyhetsord)}&ia=news&format=rss`,
  ];

  for (const url of urls) {
    const r = await hent(url);
    if (!r.ok || r.tekst.length < 100) continue;
    const items = parseRSS(r.tekst);
    if (items.length) return items;
    await new Promise(r => setTimeout(r, 300));
  }

  // Fallback: søk via Doffin på selskapets navn i pressemeldinger og kunngjøringer
  return [];
}

// ---- Hoved ----
(async () => {
  if (!fs.existsSync('konkurrenter.json')) {
    console.error('Mangler konkurrenter.json'); process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync('konkurrenter.json', 'utf8'));
  const selskaper = cfg.selskaper || [];
  console.log(`Overvåker ${selskaper.length} konkurrenter ...`);

  const resultat = {};

  for (let i = 0; i < selskaper.length; i++) {
    const s = selskaper[i];
    console.log(`  [${i+1}/${selskaper.length}] ${s.navn}`);

    const [doffin, nyheter] = await Promise.all([
      søkDoffin(s),
      søkNyheter(s)
    ]);

    const doffinBygg   = doffin.filter(d => d.harBygg);
    const doffinAndre  = doffin.filter(d => !d.harBygg);
    const tildelinger  = doffin.filter(d => d.erTildeling && d.harBygg);

    resultat[s.id] = {
      navn: s.navn,
      kategori: s.kategori,
      oppdatert: new Date().toISOString().slice(0, 10),
      aktivitet: doffinBygg.length + tildelinger.length,
      doffin: doffinBygg.slice(0, 10),
      doffinAndre: doffinAndre.slice(0, 5),
      nyheter: nyheter.slice(0, 5),
      tildelinger: tildelinger.slice(0, 5)
    };

    if (doffinBygg.length || nyheter.length) {
      console.log(`    Doffin bygg: ${doffinBygg.length}  Nyheter: ${nyheter.length}`);
    }
    await new Promise(r => setTimeout(r, PAUSE));
  }

  const ut = {
    _oppdatert: new Date().toISOString().slice(0, 10),
    _kilde: 'Doffin (offentlige kunngjøringer) og Google News',
    selskaper: resultat
  };
  fs.writeFileSync('konkurrenter-data.json', JSON.stringify(ut, null, 1), 'utf8');
  console.log('\nSkrevet: konkurrenter-data.json');

  // Oppsummering
  const aktive = Object.values(resultat).filter(s => s.aktivitet > 0);
  console.log(`\nAktivitet funnet: ${aktive.length} av ${selskaper.length} konkurrenter`);
  aktive.sort((a, b) => b.aktivitet - a.aktivitet)
    .slice(0, 8)
    .forEach(s => console.log(`  ${s.aktivitet.toString().padStart(3)}  ${s.navn}`));
})();
