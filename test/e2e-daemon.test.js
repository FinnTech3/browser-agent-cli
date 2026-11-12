// Daemon lifecycle: auto-start, stop, restart, stale files, crashes, concurrency, idle exit.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixtureServer } from './support/server.js';
import { Bac, childPids, processAlive } from './support/cli.js';

let fx;
const homes = [];

before(async () => {
  fx = await startFixtureServer();
});

after(async () => {
  await fx.close();
});

function make(opts = {}) {
  const bac = new Bac(opts);
  homes.push(bac);
  return bac;
}

async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

describe('start, stop, restart', () => {
  const bac = make({ session: 'life' });
  after(() => bac.cleanup());

  it('status and stop do not create the runtime directory or start a daemon', async () => {
    const fresh = path.join(bac.home, 'never-created');
    const env = { BAC_HOME: fresh };
    assert.equal((await bac.ok(['status'], { env })).stdout.trim(), 'not running');
    assert.equal((await bac.ok(['stop'], { env })).stdout.trim(), 'ok not running');
    assert.equal(fs.existsSync(fresh), false);
  });

  it('status reports not running before any command, and does not start a daemon', async () => {
    const r = await bac.ok(['status']);
    assert.equal(r.stdout.trim(), 'not running');
    assert.equal(bac.pid(), null);
    const j = await bac.ok(['--json', 'status']);
    assert.deepEqual({ ok: j.json.ok, running: j.json.running }, { ok: true, running: false });
  });

  it('starts the daemon on the first command and shares the page between calls', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`]);
    assert.ok(bac.pid() > 0);
    const text = (await bac.ok(['text'])).stdout;
    assert.match(text, /Create your account/);
    const status = (await bac.ok(['status'])).stdout;
    assert.match(status, /^running {2}pid \d+, session "life", up \d+s/m);
    assert.match(status, /browser {2}chromium \d+/);
    const json = (await bac.ok(['--json', 'status'])).json;
    assert.equal(json.pid, bac.pid());
    assert.equal(json.tabs, 1);
  });

  it('keeps the daemon socket private to its owner (mode 0600)', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`]);
    assert.equal(fs.statSync(path.join(bac.home, 'life.sock')).mode & 0o777, 0o600);
  });

  it('stop ends the daemon and its browser and removes the socket and pid file', async () => {
    const pid = bac.pid();
    const kids = childPids(pid);
    assert.ok(kids.length > 0, 'the daemon owns a browser process');
    const r = await bac.ok(['stop']);
    assert.equal(r.stdout.trim(), 'ok stopped');
    assert.equal(processAlive(pid), false);
    assert.ok(await waitFor(() => kids.every((k) => !processAlive(k))), 'browser processes are gone');
    assert.equal(fs.existsSync(path.join(bac.home, 'life.sock')), false);
    assert.equal(fs.existsSync(path.join(bac.home, 'life.pid')), false);
  });

  it('stop is idempotent', async () => {
    const r = await bac.run(['stop']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ok not running/);
  });

  it('restarts transparently with a fresh browser after a stop', async () => {
    const before = bac.pid();
    await bac.ok(['go', `${fx.origin}/list.html`]);
    const after = bac.pid();
    assert.ok(after && after !== before);
    const tabs = (await bac.ok(['tabs'])).stdout;
    assert.match(tabs, /tabs: 1 open/);
    assert.match(tabs, /list\.html/);
  });
});

describe('crash recovery', () => {
  const bac = make({ session: 'crash' });
  after(() => bac.cleanup());

  it('recovers from a daemon killed with SIGKILL (stale socket and pid file)', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`]);
    const pid = bac.pid();
    const kids = childPids(pid);
    process.kill(pid, 'SIGKILL');
    assert.ok(await waitFor(() => !processAlive(pid)));
    assert.equal(fs.existsSync(path.join(bac.home, 'crash.sock')), true, 'stale socket left behind');
    const r = await bac.run(['go', `${fx.origin}/list.html`]);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(bac.pid(), pid);
    assert.match((await bac.ok(['text'])).stdout, /Todo list/);
    assert.ok(await waitFor(() => kids.every((k) => !processAlive(k))), 'orphaned browser exited');
  });

  it('recovers from a stale pid file without a socket', async () => {
    await bac.ok(['stop']);
    fs.writeFileSync(path.join(bac.home, 'crash.pid'), '999999\n');
    const r = await bac.run(['go', `${fx.origin}/form.html`]);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(bac.pid(), 999999);
  });

  it('recovers from a leftover socket file with no process behind it', async () => {
    await bac.ok(['stop']);
    fs.writeFileSync(path.join(bac.home, 'crash.sock'), '');
    const r = await bac.run(['go', `${fx.origin}/form.html`]);
    assert.equal(r.code, 0, r.stderr);
  });

  it('a killed browser makes the daemon exit, and the next command starts a new session', async () => {
    const pid = bac.pid();
    const browserPid = childPids(pid)[0];
    process.kill(browserPid, 'SIGKILL');
    assert.ok(await waitFor(() => !processAlive(pid), 10000), 'daemon exits when its browser dies');
    const r = await bac.run(['go', `${fx.origin}/form.html`]);
    assert.equal(r.code, 0, r.stderr);
    assert.notEqual(bac.pid(), pid);
  });

  it('a command that hits a dead browser reports browser_lost (exit 8), then the next one works', async () => {
    const pid = bac.pid();
    const browserPid = childPids(pid)[0];
    // Freeze the daemon so it cannot exit before the command arrives, then kill the browser.
    process.kill(pid, 'SIGSTOP');
    process.kill(browserPid, 'SIGKILL');
    const pending = bac.run(['text']);
    await new Promise((r) => setTimeout(r, 300));
    process.kill(pid, 'SIGCONT');
    const r = await pending;
    assert.equal(r.code, 8);
    assert.match(r.stderr, /^error\[(browser_lost|daemon_unavailable)\]:/);
    assert.ok(await waitFor(() => !processAlive(pid), 10000));
    assert.equal((await bac.run(['go', `${fx.origin}/form.html`])).code, 0);
  });

  it('stop terminates a daemon that does not answer', async () => {
    const pid = bac.pid();
    process.kill(pid, 'SIGSTOP');
    const kids = childPids(pid);
    const r = await bac.run(['stop'], { env: { BAC_STOP_GRACE_MS: '600' } });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ok stopped \(had to terminate the daemon\)/);
    assert.equal(processAlive(pid), false);
    assert.ok(await waitFor(() => kids.every((k) => !processAlive(k))));
    assert.equal(fs.existsSync(path.join(bac.home, 'crash.sock')), false);
  });
});

describe('concurrency and isolation', () => {
  const bac = make({ session: 'conc' });
  after(() => bac.cleanup());

  it('parallel cold starts share one daemon', async () => {
    const results = await Promise.all(
      [0, 1, 2, 3].map(() => bac.run(['go', `${fx.origin}/form.html`])),
    );
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const pid = bac.pid();
    const daemons = (await bac.ok(['--json', 'status'])).json;
    assert.equal(daemons.pid, pid);
    const procs = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => {
      try {
        return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes('daemon-main.js') &&
          fs.readFileSync(`/proc/${d}/environ`, 'utf8').includes(`BAC_HOME=${bac.home}\0`);
      } catch {
        return false;
      }
    });
    assert.equal(procs.length, 1, `daemons for this home: ${procs}`);
  });

  it('parallel commands are queued, not interleaved', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const name = Bac.refFor(look, 'textbox', 'Full name');
    const writes = await Promise.all(['a', 'bb', 'ccc'].map((v) => bac.run(['put', name, v])));
    for (const w of writes) assert.equal(w.code, 0, w.stderr);
    const value = /textbox "Full name" required(?: focused)? value="([^"]*)"/.exec((await bac.ok(['look'])).stdout)[1];
    assert.ok(['a', 'bb', 'ccc'].includes(value), value);
  });

  it('sessions are separate browsers with separate pages', async () => {
    const other = make({ session: 'other', home: bac.home });
    await other.ok(['go', `${fx.origin}/list.html`]);
    assert.notEqual(other.pid(), bac.pid());
    assert.match((await other.ok(['text'])).stdout, /Todo list/);
    assert.match((await bac.ok(['text'])).stdout, /Create your account/);
    await other.ok(['stop']);
    assert.ok(processAlive(bac.pid()), 'stopping one session leaves the other running');
  });

  it('rejects an invalid session name', async () => {
    const r = await bac.run(['--session', '../x', 'status']);
    assert.equal(r.code, 2);
  });
});

describe('idle shutdown', () => {
  const bac = make({ session: 'idle' });
  after(() => bac.cleanup());

  it('the daemon exits by itself after the idle time and cleans up', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`], { env: { BAC_IDLE_SECONDS: '2' } });
    const pid = bac.pid();
    assert.ok(await waitFor(() => !processAlive(pid), 12000), 'daemon exited');
    assert.equal(fs.existsSync(path.join(bac.home, 'idle.sock')), false);
    assert.equal((await bac.ok(['status'])).stdout.trim(), 'not running');
    assert.equal((await bac.run(['go', `${fx.origin}/form.html`], { env: { BAC_IDLE_SECONDS: '60' } })).code, 0);
  });
});

describe('startup failures', () => {
  const bac = make({ session: 'nobrowser' });
  after(() => bac.cleanup());

  it('reports a missing browser as one actionable line and leaves no files behind', async () => {
    const r = await bac.run(['go', `${fx.origin}/form.html`], { env: { PLAYWRIGHT_BROWSERS_PATH: path.join(bac.home, 'nope') } });
    assert.equal(r.code, 8);
    assert.match(r.stderr, /^error\[daemon_unavailable\]: browser daemon exited during start: failed to start: browser failed to launch/);
    assert.equal(r.stderr.trim().split('\n').length, 1);
    assert.equal(fs.existsSync(path.join(bac.home, 'nobrowser.pid')), false);
    assert.equal(fs.existsSync(path.join(bac.home, 'nobrowser.sock')), false);
  });

  it('does not repeat an earlier failed start in the message of a later one', async () => {
    const env = { PLAYWRIGHT_BROWSERS_PATH: path.join(bac.home, 'nope') };
    await bac.run(['go', `${fx.origin}/form.html`], { env });
    const r = await bac.run(['go', `${fx.origin}/form.html`], { env });
    assert.equal(r.stderr.split('failed to start:').length - 1, 1, r.stderr);
  });

  it('refuses a runtime directory that other users can access', async () => {
    const open = fs.mkdtempSync(path.join(bac.home, 'open-'));
    fs.chmodSync(open, 0o755);
    const r = await bac.run(['go', `${fx.origin}/form.html`], { env: { BAC_HOME: open } });
    assert.equal(r.code, 8);
    assert.match(r.stderr, /accessible to other users/);
    assert.equal(fs.statSync(open).mode & 0o777, 0o755, 'permissions are left alone');
  });

  it('refuses a runtime directory owned by another user', { skip: process.getuid?.() !== 0 }, async () => {
    const foreign = fs.mkdtempSync(path.join(bac.home, 'foreign-'));
    fs.chownSync(foreign, 12345, 12345);
    const r = await bac.run(['go', `${fx.origin}/form.html`], { env: { BAC_HOME: foreign } });
    assert.equal(r.code, 8);
    assert.match(r.stderr, /owned by another user/);
  });

  it('refuses a runtime directory owned by a symlink', async () => {
    const real = fs.mkdtempSync(path.join(bac.home, 'real-'));
    const link = path.join(bac.home, 'link');
    fs.symlinkSync(real, link);
    const r = await bac.run(['go', `${fx.origin}/form.html`], { env: { BAC_HOME: link } });
    assert.equal(r.code, 8);
    assert.match(r.stderr, /not a plain directory/);
  });
});

after(async () => {
  for (const bac of homes) await bac.cleanup();
});
