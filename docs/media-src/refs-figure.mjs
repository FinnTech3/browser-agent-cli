// Draw the "what the page looks like / what the agent reads" figure from REAL data:
//   - a screenshot taken by `bac shot`,
//   - the output of `bac look` on the same page (parsed and checked),
//   - element boxes measured with Playwright, used only to place the badges.
// Usage: node refs-figure.mjs OUT.png [BASE_URL]   (needs `bac` on PATH, and the demo site served: node serve.mjs)
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const out = process.argv[2];
const base = process.argv[3] || 'http://127.0.0.1:8765';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-fig-'));
// its own session, so the refs start at e1 whatever else ran before
const bac = (...a) => execFileSync('bac', ['--session', 'figure', ...a], { cwd: tmp, encoding: 'utf8' });

bac('go', `${base}/signup.html`);
const look = bac('look');
bac('shot', 'page.png');
bac('stop');

// ref -> [selector in the page, colour]. The look output must contain the matching line, or we stop.
const wanted = {
  e2: ['h1', '#475569', 'heading "Create your account"'],
  e4: ['#name', '#2563eb', 'textbox "Full name"'],
  e5: ['#email', '#0d9488', 'textbox "Email"'],
  e6: ['#plan', '#7c3aed', 'combobox "Plan"'],
  e7: ['form button', '#ea580c', 'button "Create account"'],
  e8: ['footer', '#dc2626', 'contentinfo "Note to AI agents'],
};
const lines = look.split('\n');
for (const [ref, [, , frag]] of Object.entries(wanted)) {
  if (!lines.some((l) => l.trim().startsWith(`${ref} `) && l.includes(frag))) throw new Error(`look output has no ${ref} ${frag}`);
}

const sizes = {
  html: Buffer.byteLength(await (await fetch(`${base}/signup.html`)).text()),
  look: Buffer.byteLength(look),
  png: fs.statSync(path.join(tmp, 'page.png')).size,
};
const browser = await chromium.launch();
const probe = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await probe.goto(`${base}/signup.html`);
const boxes = {};
for (const [ref, [sel]] of Object.entries(wanted)) boxes[ref] = await probe.locator(sel).first().boundingBox();
await probe.close();

const CROP = { x: 380, y: 0, w: 520, h: 640 };
const img = `data:image/png;base64,${fs.readFileSync(path.join(tmp, 'page.png')).toString('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const badges = Object.entries(wanted).map(([ref, [, col]]) => {
  const b = boxes[ref];
  const x = b.x - CROP.x, y = b.y - CROP.y;
  return `<div class="frame" style="left:${x - 3}px;top:${y - 3}px;width:${b.width + 6}px;height:${b.height + 6}px;border-color:${col}"></div>` +
         `<div class="tag" style="left:${x + b.width - 22}px;top:${y - 15}px;background:${col}">${ref}</div>`;
}).join('');
const rows = lines.map((l) => {
  const m = l.match(/^(\s*)(e\d+)( .*)$/);
  const col = m && wanted[m[2]] ? wanted[m[2]][1] : null;
  const cls = l.startsWith('<<<') || l.startsWith('look #') || l.startsWith('url:') || l.startsWith('title:') ? 'dim' : '';
  const body = col ? `${esc(m[1])}<b style="background:${col}">${m[2]}</b>${esc(m[3])}` : esc(l);
  return `<div class="ln ${cls}${col === '#dc2626' ? ' bad' : ''}">${body}</div>`;
}).join('');

const maxBytes = Math.max(...Object.values(sizes));
const fmt = (n) => n.toLocaleString('en-GB');
const bar = (label, n, col) => `<div class="bar"><span class="bl">${label}</span><span class="bt"><i style="width:${Math.max(2, (n / maxBytes) * 100)}%;background:${col}"></i></span><span class="bn">${fmt(n)} bytes</span></div>`;
const page = await browser.newPage({ viewport: { width: 1300, height: 760 }, deviceScaleFactor: 1 });
await page.setContent(`<style>
*{box-sizing:border-box}body{margin:0;background:#0b1620;font-family:system-ui,'Segoe UI',Helvetica,sans-serif;color:#d7e3ec}
.wrap{display:flex;gap:34px;padding:30px 34px}
h2{margin:0 0 12px;font-size:15px;letter-spacing:.04em;text-transform:uppercase;color:#7fa6bf;font-weight:600}
.shot{position:relative;width:${CROP.w}px;height:${CROP.h}px;overflow:hidden;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
.shot img{position:absolute;left:${-CROP.x}px;top:${-CROP.y}px;width:1280px;height:800px}
.frame{position:absolute;border:2.5px solid;border-radius:8px}
.tag{position:absolute;font:700 12px 'DejaVu Sans Mono',monospace;color:#fff;padding:2px 6px;border-radius:5px}
.right{flex:1}
.term{background:#0d1117;border-radius:10px;padding:16px 18px;font:12.5px/1.6 'DejaVu Sans Mono',Menlo,monospace;box-shadow:0 10px 30px rgba(0,0,0,.5);overflow:hidden}
.ln{white-space:pre-wrap;min-height:20px;padding-left:2.5ch;text-indent:-2.5ch}.dim{color:#6e7f8f}.bad{color:#ff8a80}
b{color:#fff;border-radius:4px;padding:1px 5px;font-weight:700}
.note{margin-top:14px;font-size:14px;line-height:1.5;color:#9fb6c6;max-width:640px}
.sizes{margin-top:26px}.bar{display:flex;align-items:center;gap:12px;margin:9px 0;font-size:14px}.bl{width:170px;color:#9fb6c6}.bt{flex:1;height:14px;background:#12212d;border-radius:7px;overflow:hidden}.bt i{display:block;height:100%;border-radius:7px}.bn{width:110px;text-align:right;font-family:'DejaVu Sans Mono',monospace;font-size:13px}
</style><div class="wrap">
<div><h2>What a person sees</h2><div class="shot"><img src="${img}">${badges}</div></div>
<div class="right"><h2>What the agent reads: <span style="text-transform:none;letter-spacing:0">bac look</span></h2><div class="term">${rows}</div>
<div class="note">Same page, same moment. Colours match refs to elements. The red line is text the page planted in its footer: it arrives inside the fence as data, never as an instruction.</div>
<div class="sizes"><h2>The same page, three ways</h2>${bar('bac look (text)', sizes.look, '#38bdf8')}${bar('raw HTML', sizes.html, '#94a3b8')}${bar('screenshot (PNG file)', sizes.png, '#f59e0b')}</div></div>
</div>`);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', out, JSON.stringify(sizes));
