// Turns the downloaded cellivo.com pages into files the Next.js site renders.
// Run from .cellivo-ref: node build.mjs
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import prefixer from 'postcss-prefix-selector';

const RAW = path.resolve('raw');
const FE = path.resolve('../frontend');
const OUT = path.join(FE, 'src/site');
fs.mkdirSync(path.join(OUT, 'pages'), { recursive: true });

const rw = (h) => h
  .replaceAll('https://account.cellivo.com/login', '/login')
  .replace(/https:\/\/account\.cellivo\.com[^"]*/g, '/signup')
  .replace(/(src|href|srcSet)="\/(assets|uploads)\//g, '$1="/cellivo/$2/')
  .replace(/, \/(assets|uploads)\//g, ', /cellivo/$1/')
  .replace(/href="https:\/\/cellivo\.com\/?/g, 'href="/');

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const meta = {};
let footer = '';
for (const file of fs.readdirSync(path.join(RAW, 'pages'))) {
  const html = fs.readFileSync(path.join(RAW, 'pages', file), 'utf8');
  const slug = file.replace(/\.html$/, '').replace('__', '/');
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>') + 7);
  if (!main.startsWith('<main')) throw new Error(`no <main> in ${file}`);
  fs.writeFileSync(path.join(OUT, 'pages', file), rw(main));
  if (slug === 'home') footer = rw(html.slice(html.indexOf('<footer'), html.indexOf('</footer>') + 9));
  meta[slug] = {
    title: decode((html.match(/<title[^>]*>([^<]*)<\/title>/) || [])[1] || 'Cellivo'),
    description: decode((html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/) || [])[1] || ''),
  };
  if (slug === 'pricing') {
    const raw = html.slice(html.indexOf('__CELLIVO_INITIAL_DATA__=') + 25);
    const data = JSON.parse(raw.slice(0, raw.indexOf('</script>')).trim().replace(/;$/, ''));
    fs.writeFileSync(path.join(OUT, 'pricing.json'), JSON.stringify(data.pricingPlanLinks.map(({ planKey, billingCycle, lkrPrice, usdPrice }) => ({ planKey, billingCycle, lkrPrice, usdPrice })), null, 1));
  }
}
fs.writeFileSync(path.join(OUT, 'footer.html'), footer);
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));

// Images -> public/cellivo
const copyDir = (src, dst) => {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (!/\.(js|css)$/.test(e.name)) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(s, d); }
  }
};
copyDir(path.join(RAW, 'assets'), path.join(FE, 'public/cellivo/assets'));
copyDir(path.join(RAW, 'uploads'), path.join(FE, 'public/cellivo/uploads'));

// CSS: scope every rule under .cv so the site styles never touch the POS app.
const cssFile = fs.readdirSync(path.join(RAW, 'assets')).find((f) => /^index-.*\.css$/.test(f));
// cellivo.com loads no web fonts (falls back to system-ui), so the font names are kept as they are.
const css = fs.readFileSync(path.join(RAW, 'assets', cssFile), 'utf8');
const scoped = postcss([prefixer({
  prefix: '.cv',
  transform: (prefix, sel, prefixed) => {
    if (sel === ':root' || sel === 'html' || sel === 'body' || sel === ':host') return prefix;
    if (sel.startsWith('html ') || sel.startsWith('body ')) return `${prefix} ${sel.slice(5)}`;
    if (sel.startsWith('.dark')) return `${prefix}${sel}`;
    return prefixed;
  },
})]).process(css, { from: undefined }).css;
fs.writeFileSync(path.join(OUT, 'cellivo.css'), `/* cellivo.com stylesheet (${cssFile}), scoped to .cv by .cellivo-ref/build.mjs */\n${scoped}`);
console.log('pages', Object.keys(meta).length, 'css', scoped.length);
