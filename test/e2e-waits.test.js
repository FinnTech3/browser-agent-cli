// Waiting, timeouts, visibility and scrolling.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './support/server.js';
import { Bac } from './support/cli.js';

let fx;
let bac;

before(async () => {
  fx = await startFixtureServer();
  bac = new Bac({ session: 'waits' });
});

after(async () => {
  await bac.cleanup();
  await fx.close();
});

describe('delayed element', () => {
  it('is not there on the first look, then until css waits for it', async () => {
    await bac.ok(['go', `${fx.origin}/delayed.html`]);
    const early = (await bac.ok(['look'])).stdout;
    assert.doesNotMatch(early, /Late button/);
    assert.match(early, /Loading\.\.\./);
    const waited = await bac.ok(['--timeout', '5s', 'until', 'css', '#late']);
    assert.match(waited.stdout, /^ok "#late" is visible after \d+ms/);
    const late = (await bac.ok(['look'])).stdout;
    assert.match(late, /button "Late button"/);
  });

  it('until text and until gone observe text changes', async () => {
    await bac.ok(['go', `${fx.origin}/delayed.html`]);
    const gone = await bac.ok(['until', 'gone', 'Loading...']);
    assert.match(gone.stdout, /^ok text "Loading\.\.\." disappeared after/);
    const text = await bac.ok(['until', 'text', 'Loaded after delay']);
    assert.match(text.stdout, /^ok text "Loaded after delay" appeared after/);
  });

  it('the delayed button can be tapped once it exists', async () => {
    await bac.ok(['go', `${fx.origin}/delayed.html`]);
    await bac.ok(['until', 'css', '#late']);
    const ref = Bac.refFor((await bac.ok(['look'])).stdout, 'button', 'Late button');
    await bac.ok(['tap', ref]);
    await bac.ok(['until', 'text', 'Late button was clicked']);
  });

  it('until url and until idle succeed on a settled page', async () => {
    assert.match((await bac.ok(['until', 'url', '/delayed.html'])).stdout, /^ok url contains "\/delayed\.html"/);
    assert.match((await bac.ok(['until', 'idle'])).stdout, /^ok network is idle/);
  });

  it('until css --hidden waits for an element to go away', async () => {
    const r = await bac.ok(['until', 'css', '#does-not-exist', '--hidden']);
    assert.match(r.stdout, /is hidden/);
  });
});

describe('timeouts', () => {
  it('until text that never appears fails with exit 5 and a one-line message', async () => {
    await bac.ok(['go', `${fx.origin}/delayed.html`]);
    const started = Date.now();
    const r = await bac.run(['--timeout', '700ms', 'until', 'text', 'this text never appears']);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /^error\[timeout\]: timed out after 700ms waiting for text "this text never appears"/);
    assert.match(r.stderr, /Run: bac look/);
    assert.equal(r.stderr.trim().split('\n').length, 1);
    assert.ok(Date.now() - started < 4000);
  });

  it('a slow page load with a short --timeout fails with exit 5', async () => {
    const r = await bac.run(['--timeout', '1s', 'go', `${fx.origin}/slow`]);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /^error\[timeout\]: timed out after 1000ms waiting for the page to load/);
  });

  it('the session still works after a timeout', async () => {
    const r = await bac.run(['go', `${fx.origin}/form.html`]);
    assert.equal(r.code, 0);
  });

  it('BAC_TIMEOUT sets the default and --timeout overrides it', async () => {
    const viaEnv = await bac.run(['until', 'text', 'nope'], { env: { BAC_TIMEOUT: '600ms' } });
    assert.equal(viaEnv.code, 5);
    assert.match(viaEnv.stderr, /after 600ms/);
    const viaFlag = await bac.run(['--timeout', '650ms', 'until', 'text', 'nope'], { env: { BAC_TIMEOUT: '5s' } });
    assert.match(viaFlag.stderr, /after 650ms/);
  });

  it('rejects a nonsense --timeout as a usage error', async () => {
    const r = await bac.run(['--timeout', 'soon', 'look']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--timeout must look like/);
  });
});

describe('visibility, overlays and scrolling', () => {
  let look;

  it('a button covered by an overlay fails with exit 4 instead of clicking blindly', async () => {
    await bac.ok(['go', `${fx.origin}/overlay.html`]);
    look = (await bac.ok(['look'])).stdout;
    const under = Bac.refFor(look, 'button', 'Under the cover');
    const r = await bac.run(['--timeout', '1500ms', 'tap', under]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /^error\[obscured\]: e\d+ is covered by another element/);
    assert.match((await bac.ok(['text'])).stdout, /nothing yet/);
  });

  it('hidden elements are not in the snapshot', () => {
    assert.doesNotMatch(look, /Never shown/);
  });

  it('a far-away element can be scrolled to by ref and by direction', async () => {
    const far = Bac.refFor(look, 'button', 'Far below');
    const r = await bac.ok(['scroll', far]);
    assert.match(r.stdout, /^ok scrolled to y=\d+ of \d+/);
    const y = Number(/y=(\d+)/.exec(r.stdout)[1]);
    assert.ok(y > 500);
    assert.match((await bac.ok(['scroll', 'top'])).stdout, /y=0 of \d+, at the top/);
    assert.match((await bac.ok(['scroll', 'down'])).stdout, /y=640/);
    assert.match((await bac.ok(['scroll', 'down', '--px', '100'])).stdout, /y=740/);
    assert.match((await bac.ok(['scroll', 'bottom'])).stdout, /at the bottom/);
  });
});
