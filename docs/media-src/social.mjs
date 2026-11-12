// docs/social-preview.png (1280 x 640): logo, name, promise, and two REAL things from the demo recording:
// a screenshot saved by `bac shot` and lines from the recorded `bac look` output.
// Usage: node social.mjs OUT.png FORM.png HERO.cast.json LOGO.png
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');
const [,, out, formPng, castFile, logoPng] = process.argv;
const b64 = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
const cast = JSON.parse(fs.readFileSync(castFile, 'utf8'));
const text = cast.steps.filter((s) => s.type === 'out').map((s) => s.text).join('\n').split('\n');
const want = ['e4 textbox "Full name" required', 'e5 textbox "Email" required', 'e7 button "Create account"'];
const shown = want.map((w) => {
  const l = text.find((t) => t.trim() === w);
  if (!l) throw new Error(`recorded output has no line: ${w}`);
  return l;
});
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.setContent(`<style>
*{box-sizing:border-box}body{margin:0;width:1280px;height:640px;overflow:hidden;position:relative;background:linear-gradient(135deg,#0369a1 0%,#082f49 78%);font-family:system-ui,'Segoe UI',Helvetica,sans-serif;color:#fff}
.logo{position:absolute;left:84px;top:96px;width:112px;height:112px;border-radius:26px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
h1{position:absolute;left:84px;top:238px;margin:0;font-size:68px;letter-spacing:-.02em}
.promise{position:absolute;left:84px;top:332px;width:560px;font-size:33px;line-height:1.3;color:#cfe8f7;text-wrap:balance}
.meta{position:absolute;left:84px;bottom:56px;font-size:22px;color:#8fbbd6}
.shot{position:absolute;left:780px;top:70px;width:396px;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.5)}
.term{position:absolute;left:690px;top:372px;width:520px;background:#0d1117;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);padding:16px 20px;font:16px/1.65 'DejaVu Sans Mono',Menlo,monospace;color:#e6edf3;white-space:pre}
.term .p{color:#7ee787}.term .d{color:#6e7f8f}
</style>
<img class="logo" src="${b64(logoPng)}"><h1>browser-agent-cli</h1>
<div class="promise">Give an AI agent a real browser it can drive one shell command at a time.</div>
<div class="meta">Built by FinnTech3 &nbsp;·&nbsp; MIT &nbsp;·&nbsp; Node 20+</div>
<img class="shot" src="${b64(formPng)}">
<div class="term"><span class="p">$</span> bac look\n<span class="d">...</span>\n${shown.map(esc).join('\n')}</div>`);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
