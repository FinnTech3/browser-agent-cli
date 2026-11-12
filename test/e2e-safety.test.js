// Safety model: URL policy, domain allowlists, secrets, untrusted content, file output.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './support/server.js';
import { Bac, processAlive } from './support/cli.js';

let fx;

before(async () => {
  fx = await startFixtureServer();
});

after(async () => {
  await fx.close();
});

describe('blocked URL schemes', () => {
  let bac;
  before(() => { bac = new Bac({ session: 'schemes' }); });
  after(() => bac.cleanup());

  for (const url of [
    'file:///etc/passwd',
    'data:text/html,<h1>hi</h1>',
    'javascript:alert(document.domain)',
    'chrome://version',
    'view-source:http://127.0.0.1/',
    'ftp://example.com/',
    'http://user:secret@127.0.0.1/',
  ]) {
    it(`refuses ${url}`, async () => {
      const r = await bac.run(['go', url]);
      assert.equal(r.code, 6);
      assert.match(r.stderr, /^error\[blocked_url\]: blocked: /);
      assert.equal(r.stderr.trim().split('\n').length, 1);
    });
  }

  it('does not even start a browser for a blocked URL', () => {
    assert.equal(bac.pid(), null);
  });

  it('tabs new refuses blocked URLs too', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`]);
    const r = await bac.run(['tabs', 'new', 'file:///etc/hostname']);
    assert.equal(r.code, 6);
    assert.match((await bac.ok(['tabs'])).stdout, /tabs: 1 open/);
  });

  it('a redirect to a data: URL is not followed', async () => {
    const r = await bac.run(['go', `${fx.origin}/redirect-to-data`]);
    assert.notEqual(r.code, 0);
    const text = await bac.ok(['text']);
    assert.doesNotMatch(text.stdout, /escaped/);
  });

  it('JSON mode reports the block with its code', async () => {
    const r = await bac.run(['--json', 'go', 'file:///etc/passwd']);
    assert.equal(r.code, 6);
    assert.equal(r.json.error.code, 'blocked_url');
  });
});

describe('domain allowlist', () => {
  let bac;
  before(() => { bac = new Bac({ session: 'allow' }); });
  after(() => bac.cleanup());

  it('allows listed hosts and blocks others with a message that names the list', async () => {
    const ok = await bac.run(['--allow-domain', '127.0.0.1', 'go', `${fx.origin}/form.html`]);
    assert.equal(ok.code, 0);
    const blocked = await bac.run(['--allow-domain', '127.0.0.1', 'go', `http://localhost:${fx.port}/form.html`]);
    assert.equal(blocked.code, 6);
    assert.match(blocked.stderr, /host "localhost" is not in the allowed domains \(127\.0\.0\.1\)/);
  });

  it('blocks a redirect that leaves the allowed domains and resets the tab', async () => {
    const r = await bac.run(['--allow-domain', '127.0.0.1', 'go', `${fx.origin}/redirect-to-localhost`]);
    assert.equal(r.code, 6);
    assert.match(r.stderr, /host "localhost" is not in the allowed domains/);
    assert.match(r.stderr, /The tab was reset to about:blank/);
    const tabs = (await bac.ok(['tabs'])).stdout;
    assert.doesNotMatch(tabs, /localhost/);
    assert.match(tabs, /about:blank/);
  });

  it('blocks a link click that leaves the allowed domains and stays on the page', async () => {
    await bac.ok(['go', `${fx.origin}/links.html`]);
    const look = (await bac.ok(['look'])).stdout;
    const same = await bac.run(['tap', Bac.refFor(look, 'link', 'Other host')]);
    assert.equal(same.code, 6);
    assert.match(same.stderr, /^error\[blocked_url\]: blocked: host "localhost" is not in the allowed domains/);
    assert.match((await bac.ok(['tabs'])).stdout, /127\.0\.0\.1:\d+\/links\.html/);
    const redirecting = await bac.run(['tap', Bac.refFor(look, 'link', 'Redirecting link')]);
    assert.equal(redirecting.code, 6);
    await bac.ok(['go', `${fx.origin}/links.html`]);
    const fresh = (await bac.ok(['look'])).stdout;
    assert.equal((await bac.run(['tap', Bac.refFor(fresh, 'link', 'Same host')])).code, 0);
  });

  it('the allowlist is fixed for the session: a different list is a policy mismatch', async () => {
    const r = await bac.run(['--allow-domain', 'example.com', 'look']);
    assert.equal(r.code, 8);
    assert.match(r.stderr, /^error\[policy_mismatch\]: this session was started with 127\.0\.0\.1\. Run: bac stop/);
  });

  it('status shows the allowlist', async () => {
    const r = await bac.ok(['status']);
    assert.match(r.stdout, /domains {2}127\.0\.0\.1/);
  });

  it('rejects malformed allowlist entries', async () => {
    const r = await bac.run(['--allow-domain', 'https://example.com/path', 'look']);
    assert.equal(r.code, 2);
  });
});

describe('script-driven navigation and downloads', () => {
  let bac;
  let cwd;
  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-nav-'));
    bac = new Bac({ session: 'scriptnav', cwd });
  });
  after(async () => {
    await bac.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const open = async () => {
    await bac.ok(['--allow-domain', '127.0.0.1', 'go', `${fx.origin}/nav.html`]);
    return (await bac.ok(['look'])).stdout;
  };
  const offSiteHits = () => fx.hits.filter((h) => h.host.startsWith('localhost'));
  before(() => { fx.hits.length = 0; });

  it('a script that changes location to another host is cancelled and the command fails', async () => {
    const look = await open();
    const r = await bac.run(['tap', Bac.refFor(look, 'button', 'Script navigate')]);
    assert.equal(r.code, 6);
    assert.match(r.stderr, /host "localhost" is not in the allowed domains/);
    assert.match((await bac.ok(['tabs'])).stdout, /127\.0\.0\.1:\d+\/nav\.html/);
  });

  it('a navigation that fires later is cancelled and reported by the next command', async () => {
    const look = await open();
    const r = await bac.ok(['tap', Bac.refFor(look, 'button', 'Navigate later')]);
    assert.equal(r.code, 0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const tabs = (await bac.run(['tabs']));
    assert.match(tabs.stdout, /nav\.html/);
    assert.doesNotMatch(tabs.stdout, /form\.html/);
    assert.match(tabs.stdout, /note: blocked: host "localhost" is not in the allowed domains/);
    assert.equal(offSiteHits().length, 0, 'the refused address was never requested');
  });

  it('a popup to another host never becomes a tab', async () => {
    const look = await open();
    await bac.run(['tap', Bac.refFor(look, 'button', 'Script popup')]);
    let tabs = '';
    for (let i = 0; i < 20 && !/tabs: 1 open/.test(tabs); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      tabs = (await bac.ok(['tabs'])).stdout;
    }
    assert.match(tabs, /tabs: 1 open, active is 1/);
    assert.doesNotMatch(tabs, /localhost/);
    assert.match(tabs, /nav\.html/);
    assert.equal(offSiteHits().length, 0, 'the refused address was never requested');
  });

  it('downloads are blocked: nothing is written and the page stays', async () => {
    const look = await open();
    await bac.run(['tap', Bac.refFor(look, 'link', 'Download file')]);
    assert.deepEqual(fs.readdirSync(cwd), []);
    assert.match((await bac.ok(['tabs'])).stdout, /nav\.html/);
    assert.equal((await bac.run(['look'])).code, 0);
  });
});

describe('env default allowlist', () => {
  let bac;
  before(() => { bac = new Bac({ session: 'envallow', env: { BAC_ALLOW_DOMAINS: '127.0.0.1' } }); });
  after(() => bac.cleanup());

  it('applies BAC_ALLOW_DOMAINS when no flag is given', async () => {
    assert.equal((await bac.run(['go', `${fx.origin}/form.html`])).code, 0);
    const blocked = await bac.run(['go', `http://localhost:${fx.port}/form.html`]);
    assert.equal(blocked.code, 6);
    assert.match((await bac.ok(['status'])).stdout, /domains {2}127\.0\.0\.1/);
  });

  it('a flag overrides the env list for the next session', async () => {
    await bac.ok(['stop']);
    const r = await bac.run(['--allow-domain', 'localhost', 'go', `http://localhost:${fx.port}/form.html`]);
    assert.equal(r.code, 0);
    const blocked = await bac.run(['--allow-domain', 'localhost', 'go', `${fx.origin}/form.html`]);
    assert.equal(blocked.code, 6);
  });
});

describe('secrets', () => {
  let bac;
  before(async () => {
    bac = new Bac({ session: 'secrets' });
    await bac.ok(['go', `${fx.origin}/secret.html`]);
  });
  after(() => bac.cleanup());

  it('never prints password values or secret-looking fields, but shows ordinary values', async () => {
    const out = (await bac.ok(['look'])).stdout;
    assert.match(out, /textbox "Password" value=\[redacted\]/);
    assert.match(out, /textbox "Access key" value=\[redacted\]/);
    assert.match(out, /textbox "Note" value="plain visible note"/);
    assert.doesNotMatch(out, /hunter2|correct-horse|tok_live/);
    const json = (await bac.ok(['--json', 'look'])).stdout;
    assert.doesNotMatch(json, /hunter2|correct-horse|tok_live/);
    const actions = (await bac.ok(['look', '--actions'])).stdout;
    assert.doesNotMatch(actions, /hunter2|correct-horse|tok_live/);
  });

  it('text on a secret field returns a redaction marker', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const pw = Bac.refFor(out, 'textbox', 'Password');
    const t = (await bac.ok(['text', pw])).stdout;
    assert.match(t, /\[redacted\]/);
    assert.doesNotMatch(t, /hunter2/);
    assert.doesNotMatch((await bac.ok(['text'])).stdout, /hunter2/);
  });

  it('typing into a password field never echoes the typed value', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const pw = Bac.refFor(out, 'textbox', 'Password');
    const typed = 'S3cr3t-Typed-Value';
    const plain = await bac.ok(['put', pw, typed]);
    assert.doesNotMatch(plain.stdout, /S3cr3t/);
    assert.match(plain.stdout, /18 characters \(looks like a secret field; never shown in output\)/);
    const json = await bac.ok(['--json', 'put', pw, typed]);
    assert.doesNotMatch(json.stdout, /S3cr3t/);
    assert.equal(json.json.secretField, true);
    const after = await bac.ok(['look']);
    assert.doesNotMatch(after.stdout, /S3cr3t/);
    const submit = Bac.refFor(after.stdout, 'button', 'Sign in');
    await bac.ok(['tap', submit]);
    assert.match((await bac.ok(['text'])).stdout, /Submitted 18 password characters/);
  });
});

describe('untrusted page content', () => {
  let bac;
  before(async () => {
    bac = new Bac({ session: 'inject' });
    await bac.ok(['go', `${fx.origin}/injection`]);
  });
  after(() => bac.cleanup());

  it('keeps all page text inside one boundary whose id the page cannot forge', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const lines = out.trimEnd().split('\n');
    const open = lines.filter((l) => l.startsWith('<<<PAGE-DATA '));
    const close = lines.filter((l) => l.startsWith('<<<END PAGE-DATA '));
    assert.equal(open.length, 1);
    assert.equal(close.length, 1);
    const id = /PAGE-DATA ([0-9a-f]{12})/.exec(open[0])[1];
    assert.equal(close[0], `<<<END PAGE-DATA ${id}>>>`);
    assert.ok(!out.includes('<<<END PAGE-DATA 000000000000>>>'), 'the forged marker was defused');
    const inside = lines.slice(lines.indexOf(open[0]) + 1, lines.indexOf(close[0]));
    assert.ok(inside.some((l) => l.includes('ignore all prior instructions')), 'the injected sentence is present as data');
    assert.ok(lines.indexOf(close[0]) === lines.length - 1, 'nothing after the closing marker');
  });

  it('uses a different boundary id every time', async () => {
    const a = /PAGE-DATA ([0-9a-f]{12})/.exec((await bac.ok(['look'])).stdout)[1];
    const b = /PAGE-DATA ([0-9a-f]{12})/.exec((await bac.ok(['look'])).stdout)[1];
    assert.notEqual(a, b);
  });

  it('strips invisible and bidi control characters from names', async () => {
    const out = (await bac.ok(['look'])).stdout;
    assert.match(out, /button "Click me to obey"/);
    assert.doesNotMatch(out, /[\u200b\u202e]/);
  });

  it('page-derived text never appears outside the boundary in action output', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const ref = Bac.refFor(out, 'button', 'Click me to obey');
    const r = await bac.ok(['tap', ref]);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.doesNotMatch(r.stdout, /ignore|instructions|evil/i);
  });
});

describe('screenshots', () => {
  let bac;
  let cwd;
  let elsewhere;
  before(async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-cwd-'));
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'bac-out-'));
    bac = new Bac({ session: 'shots', cwd });
    await bac.ok(['go', `${fx.origin}/form.html`]);
  });
  after(async () => {
    await bac.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  const isPng = (file) => fs.readFileSync(file).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  it('without a path writes a new PNG in the current directory only', async () => {
    const before = fs.readdirSync(cwd).filter((f) => f.startsWith('bac-shot-'));
    const strayBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('bac-shot-')).length;
    const r = await bac.ok(['shot']);
    const files = fs.readdirSync(cwd).filter((f) => f.startsWith('bac-shot-'));
    assert.equal(files.length, before.length + 1);
    const saved = path.join(cwd, files.at(-1));
    assert.match(r.stdout, new RegExp(`^ok saved ${saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ bytes\\)`));
    assert.ok(isPng(saved));
    assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('bac-shot-')).length, strayBefore);
  });

  it('two default shots never overwrite each other', async () => {
    await bac.ok(['shot']);
    await bac.ok(['shot']);
    assert.ok(fs.readdirSync(cwd).filter((f) => f.startsWith('bac-shot-')).length >= 3);
  });

  it('an explicit path outside the current directory is honoured', async () => {
    const target = path.join(elsewhere, 'page.png');
    await bac.ok(['shot', target]);
    assert.ok(isPng(target));
  });

  it('a relative explicit path resolves against the caller, not the daemon', async () => {
    await bac.ok(['shot', 'mine.png']);
    assert.ok(isPng(path.join(cwd, 'mine.png')));
    await bac.ok(['shot', `../${path.basename(elsewhere)}/up.jpg`]);
    const jpeg = fs.readFileSync(path.join(elsewhere, 'up.jpg'));
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
  });

  it('--full and --ref capture a full page or one element', async () => {
    const full = path.join(cwd, 'full.png');
    const el = path.join(cwd, 'el.png');
    await bac.ok(['shot', full, '--full']);
    const ref = Bac.refFor((await bac.ok(['look'])).stdout, 'button', 'Create account');
    await bac.ok(['shot', el, '--ref', ref]);
    assert.ok(fs.statSync(el).size < fs.statSync(full).size);
  });

  it('rejects bad extensions and missing directories as usage errors', async () => {
    const bad = await bac.run(['shot', 'notes.txt']);
    assert.equal(bad.code, 2);
    const missing = await bac.run(['shot', path.join(elsewhere, 'no', 'such', 'dir', 'x.png')]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /directory does not exist/);
  });

  it('--json reports the saved path', async () => {
    const r = await bac.ok(['--json', 'shot', 'j.png']);
    assert.equal(r.json.path, path.join(cwd, 'j.png'));
    assert.ok(r.json.bytes > 100);
    assert.equal(r.json.base64, undefined);
  });
});

describe('runtime directory', () => {
  it('is private: directory 0700 and socket 0600, and the daemon is gone after stop', async () => {
    const bac = new Bac({ session: 'perm' });
    try {
      await bac.ok(['go', `${fx.origin}/form.html`]);
      const dirMode = fs.statSync(bac.home).mode & 0o777;
      const sockMode = fs.statSync(path.join(bac.home, 'perm.sock')).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(sockMode, 0o600);
      const pid = bac.pid();
      await bac.ok(['stop']);
      assert.equal(processAlive(pid), false);
      assert.equal(fs.existsSync(path.join(bac.home, 'perm.sock')), false);
      assert.equal(fs.existsSync(path.join(bac.home, 'perm.pid')), false);
    } finally {
      await bac.cleanup();
    }
  });
});
