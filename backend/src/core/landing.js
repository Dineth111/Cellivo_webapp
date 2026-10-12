// Browser landing page for GET / (API clients still get JSON). CSS only: helmet's CSP blocks inline scripts.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function landingHtml({ message, version, endpoints }) {
  const cards = Object.entries(endpoints)
    .map(([name, path]) => `<a class="card" href="${esc(path)}"><b>${esc(name)}</b><code>${esc(path)}</code></a>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cellivo API</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8eaf6;
background:radial-gradient(900px 500px at 15% -10%,#3b2fb8 0,transparent 60%),radial-gradient(700px 500px at 100% 0,#0e7490 0,transparent 55%),#0b0d1a}
main{max-width:880px;margin:0 auto;padding:72px 20px}
.badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid #ffffff22;border-radius:99px;background:#ffffff0d;font-size:14px}
.dot{width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 10px #34d399}
h1{font-size:clamp(36px,7vw,60px);margin:20px 0 8px;letter-spacing:-1px;background:linear-gradient(90deg,#fff,#a5b4fc);-webkit-background-clip:text;background-clip:text;color:transparent}
p{color:#a5aac8;font-size:18px;margin:0 0 40px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}
.card{display:flex;flex-direction:column;gap:6px;padding:16px 18px;border:1px solid #ffffff1a;border-radius:14px;background:#ffffff0a;color:inherit;text-decoration:none;transition:.2s}
.card:hover{transform:translateY(-3px);border-color:#a5b4fc99;background:#ffffff14}
.card b{text-transform:capitalize}.card code{color:#93c5fd;font-size:13px}
footer{margin-top:48px;color:#6b7194;font-size:13px}
</style></head><body><main>
<span class="badge"><i class="dot"></i>${esc(message)} · v${esc(version)}</span>
<h1>Cellivo API</h1><p>Cloud POS for mobile phone shops and repair centres.</p>
<div class="grid">${cards}</div>
<footer>Send <code>Accept: application/json</code> to get this index as JSON.</footer>
</main></body></html>`;
}
