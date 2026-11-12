// Tabs, popups, dialogs, history and navigation errors.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFixtureServer } from './support/server.js';
import { Bac } from './support/cli.js';

let fx;
let bac;

before(async () => {
  fx = await startFixtureServer();
  bac = new Bac({ session: 'tabs' });
});

after(async () => {
  await bac.cleanup();
  await fx.close();
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

describe('tabs and popups', () => {
  it('a link that opens a new tab switches to it and says so', async () => {
    await bac.ok(['go', `${fx.origin}/popup.html`]);
    const look = (await bac.ok(['look'])).stdout;
    const link = Bac.refFor(look, 'link', 'Open welcome in a new tab');
    const r = await bac.ok(['tap', link]);
    assert.match(r.stdout, /^ok tapped e\d+, now at .*\/welcome\.html\?…/m);
    assert.match(r.stdout, /note: a new tab opened \(tab 2\) and is now active/);
    const tabs = (await bac.ok(['tabs'])).stdout;
    assert.match(tabs, /tabs: 2 open, active is 2/);
    assert.match(tabs, /^ {2}1 http:\/\/127\.0\.0\.1:\d+\/popup\.html "Popup test"$/m);
    assert.match(tabs, /^\* 2 http:\/\/127\.0\.0\.1:\d+\/welcome\.html\?name=Popup "Welcome"$/m);
  });

  it('tabs use switches the active tab and commands follow it', async () => {
    assert.match((await bac.ok(['tabs', 'use', '1'])).stdout, /^ok switched to tab 1/);
    assert.match((await bac.ok(['text'])).stdout, /Popup test/);
    await bac.ok(['tabs', 'use', '2']);
    assert.match((await bac.ok(['text'])).stdout, /Account created for Popup/);
  });

  it('tabs use with an unknown id is exit 4', async () => {
    const r = await bac.run(['tabs', 'use', '9']);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /^error\[not_found\]: no tab 9/);
  });

  it('tabs new opens and loads a page; tabs close removes it and activates another', async () => {
    const r = await bac.ok(['tabs', 'new', `${fx.origin}/list.html`]);
    assert.match(r.stdout, /^ok opened tab 3/);
    assert.match((await bac.ok(['text'])).stdout, /Todo list/);
    const closed = await bac.ok(['tabs', 'close']);
    assert.match(closed.stdout, /^ok closed tab 3; 2 open, active is 2/);
    assert.match((await bac.ok(['tabs', 'close', '2'])).stdout, /^ok closed tab 2; 1 open, active is 1/);
  });

  it('closing the last tab opens a fresh blank one', async () => {
    const r = await bac.ok(['tabs', 'close']);
    assert.match(r.stdout, /note: all tabs were closed; opened a fresh blank tab/);
    assert.match((await bac.ok(['tabs'])).stdout, /about:blank/);
    assert.equal((await bac.run(['go', `${fx.origin}/popup.html`])).code, 0);
  });
});

describe('dialogs', () => {
  it('JS dialogs are dismissed automatically and reported', async () => {
    await bac.ok(['go', `${fx.origin}/popup.html`]);
    const look = (await bac.ok(['look'])).stdout;
    const ask = Bac.refFor(look, 'button', 'Ask me');
    const r = await bac.ok(['tap', ask]);
    assert.match(r.stdout, /note: a confirm dialog was dismissed automatically/);
    assert.match((await bac.ok(['text'])).stdout, /Said no/);
  });
});

describe('navigation', () => {
  it('back and no history', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`]);
    await bac.ok(['go', `${fx.origin}/list.html`]);
    assert.match((await bac.ok(['back'])).stdout, /^ok went back to .*\/form\.html/);
    const r = await bac.run(['tabs', 'new']);
    assert.equal(r.code, 0);
    const none = await bac.run(['back']);
    assert.equal(none.code, 7);
    assert.match(none.stderr, /^error\[no_history\]: there is no earlier page/);
  });

  it('a refused connection is a navigation failure with exit 7', async () => {
    const port = await freePort();
    const r = await bac.run(['go', `http://127.0.0.1:${port}/`]);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /^error\[nav_failed\]: navigation failed: connection refused \(ERR_CONNECTION_REFUSED\)/);
  });

  it('an unknown host is a navigation failure too', async () => {
    const r = await bac.run(['--timeout', '8s', 'go', 'http://no-such-host.invalid/']);
    assert.equal(r.code, 7);
    assert.match(r.stderr, /^error\[nav_failed\]: navigation failed: host name not found/);
  });

  it('an HTTP error status still succeeds but carries a note', async () => {
    const r = await bac.ok(['go', `${fx.origin}/missing-status`]);
    assert.match(r.stdout, /\(HTTP 404\)/);
    assert.match(r.stdout, /note: the server answered HTTP 404/);
  });

  it('a bare host with a port gets a scheme', async () => {
    const r = await bac.ok(['go', `127.0.0.1:${fx.port}/form.html`]);
    assert.match(r.stdout, /^ok went to http:\/\/127\.0\.0\.1:\d+\/form\.html/);
  });

  it('key without a target presses on the focused element', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const name = Bac.refFor(look, 'textbox', 'Full name');
    await bac.ok(['tap', name]);
    await bac.ok(['key', 'Tab']);
    assert.match((await bac.ok(['look'])).stdout, /textbox "Email" required focused/);
  });
});
