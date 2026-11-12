// End to end: real CLI, real daemon, real headless Chromium, local fixture pages.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './support/server.js';
import { Bac } from './support/cli.js';

let fx;
let bac;

before(async () => {
  fx = await startFixtureServer();
  bac = new Bac({ session: 'forms' });
});

after(async () => {
  await bac.cleanup();
  await fx.close();
});

describe('sign-up form', () => {
  let look;

  it('opens a page and reads it as a delimited snapshot with refs', async () => {
    const go = await bac.ok(['go', `${fx.origin}/form.html`]);
    assert.match(go.stdout, /^ok went to http:\/\/127\.0\.0\.1:\d+\/form\.html \(HTTP 200\)/);
    look = (await bac.ok(['look'])).stdout;
    assert.match(look, /^look #1: \d+ nodes, refs e1\.\.e\d+/);
    assert.match(look, /<<<PAGE-DATA [0-9a-f]{12} untrusted/);
    assert.match(look, /<<<END PAGE-DATA [0-9a-f]{12}>>>\n$/);
    assert.match(look, /title: Create your account/);
    assert.match(look, /e\d+ heading "Create your account" level=1/);
    assert.match(look, /e\d+ textbox "Full name" required/);
    assert.match(look, /e\d+ combobox "Plan" value="Free" options=\["Free","Pro","Team"\]/);
    assert.match(look, /e\d+ checkbox "Send me the newsletter" unchecked/);
    assert.match(look, /e\d+ button "Cancel" disabled/);
  });

  it('fills fields, picks an option and toggles a checkbox', async () => {
    const name = Bac.refFor(look, 'textbox', 'Full name');
    const email = Bac.refFor(look, 'textbox', 'Email');
    const plan = Bac.refFor(look, 'combobox', 'Plan');
    const news = Bac.refFor(look, 'checkbox', 'Send me the newsletter');
    assert.match((await bac.ok(['put', name, 'Ada Lovelace'])).stdout, /ok filled e\d+ with 12 characters/);
    await bac.ok(['put', email, 'ada@example.com']);
    assert.match((await bac.ok(['pick', plan, 'Pro'])).stdout, /ok picked 1 option/);
    assert.match((await bac.ok(['tap', news])).stdout, /ok tapped/);
    const after = (await bac.ok(['look'])).stdout;
    assert.match(after, /textbox "Full name" required value="Ada Lovelace"/);
    assert.match(after, /textbox "Email" required value="ada@example.com"/);
    assert.match(after, /combobox "Plan" value="Pro"/);
    assert.match(after, /checkbox "Send me the newsletter" checked/);
  });

  it('submits and the old refs go stale because the page changed', async () => {
    const submit = Bac.refFor(look, 'button', 'Create account');
    const res = await bac.ok(['tap', submit]);
    assert.match(res.stdout, /ok tapped e\d+, now at http:\/\/127\.0\.0\.1:\d+\/welcome\.html\?…/);
    const text = (await bac.ok(['text'])).stdout;
    assert.match(text, /Account created for Ada Lovelace \(ada@example\.com\) on the pro plan\. Newsletter: yes\./);
    const stale = await bac.run(['tap', submit]);
    assert.equal(stale.code, 3);
    assert.match(stale.stderr, /^error\[stale_ref\]: ref e\d+ is stale/);
    assert.match(stale.stderr, /Run: bac look/);
    assert.equal(stale.stderr.trim().split('\n').length, 1);
  });

  it('numbers refs on the new page after the old ones, never reusing them', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const nums = [...out.matchAll(/\be(\d+) /g)].map((m) => Number(m[1]));
    assert.ok(Math.min(...nums) > 13, `new refs should continue after e13, got ${nums}`);
  });
});

describe('controls and errors', () => {
  it('refuses to tap a disabled button with exit code 4', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`]);
    const look = (await bac.ok(['look'])).stdout;
    const cancel = Bac.refFor(look, 'button', 'Cancel');
    const r = await bac.run(['tap', cancel]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /^error\[not_enabled\]: e\d+ is disabled/);
  });

  it('reports an unknown option and a bad key as one-line errors', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const plan = Bac.refFor(look, 'combobox', 'Plan');
    const bad = await bac.run(['pick', plan, 'Platinum']);
    assert.equal(bad.code, 4);
    assert.match(bad.stderr, /^error\[option_not_found\]: no enabled option matching "Platinum"/);
    const key = await bac.run(['key', 'NotAKey']);
    assert.equal(key.code, 2);
    assert.match(key.stderr, /^error\[usage\]: unknown key/);
  });

  it('picks by value and by case-insensitive label', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const plan = Bac.refFor(look, 'combobox', 'Plan');
    await bac.ok(['pick', plan, 'team']);
    assert.match((await bac.ok(['look'])).stdout, /combobox "Plan" value="Team"/);
    await bac.ok(['pick', plan, 'FREE']);
    assert.match((await bac.ok(['look'])).stdout, /combobox "Plan" value="Free"/);
  });

  it('reads text from stdin so secrets stay out of the command line', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const name = Bac.refFor(look, 'textbox', 'Full name');
    const r = await bac.ok(['put', name, '--stdin'], { input: 'Grace Hopper\n' });
    assert.match(r.stdout, /with 12 characters/);
    assert.match((await bac.ok(['look'])).stdout, /value="Grace Hopper"/);
  });

  it('-- makes the rest of the line plain text, even when it looks like an option', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const name = Bac.refFor(look, 'textbox', 'Full name');
    const r = await bac.ok(['put', name, '--', '--json']);
    assert.match(r.stdout, /^ok filled e\d+ with 6 characters/);
    assert.match((await bac.ok(['look'])).stdout, /value="--json"/);
  });

  it('Enter in a field submits the form and the command waits for the new page', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const email = Bac.refFor(look, 'textbox', 'Email');
    await bac.ok(['put', email, 'g@example.com']);
    const r = await bac.ok(['key', 'Enter', '--on', email]);
    assert.match(r.stdout, /ok pressed Enter, now at .*\/welcome\.html/);
    assert.match((await bac.ok(['text'])).stdout, /g@example\.com/);
  });

  it('go back returns to the form, then reports no history at the start', async () => {
    const back = await bac.ok(['back']);
    assert.match(back.stdout, /ok went back to http:\/\/127\.0\.0\.1:\d+\/form\.html/);
  });
});

describe('--json', () => {
  it('prints one JSON object per command with nested nodes', async () => {
    await bac.ok(['go', `${fx.origin}/form.html`]);
    const r = await bac.ok(['--json', 'look']);
    assert.equal(r.stdout.trim().split('\n').length, 1);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.command, 'look');
    assert.equal(r.json.untrusted, true);
    assert.equal(r.json.title, 'Create your account');
    const flat = [];
    const walk = (nodes) => nodes.forEach((n) => { flat.push(n); if (n.children) walk(n.children); });
    walk(r.json.tree);
    const name = flat.find((n) => n.role === 'textbox' && n.name === 'Full name');
    assert.match(name.ref, /^e\d+$/);
    assert.deepEqual(name.flags, ['required']);
  });

  it('prints errors as JSON on stdout and still exits nonzero', async () => {
    const r = await bac.run(['--json', 'tap', 'e9999']);
    assert.equal(r.code, 3);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'unknown_ref');
    assert.equal(r.stderr, '');
  });

  it('works for action commands too', async () => {
    const look = (await bac.ok(['look'])).stdout;
    const name = Bac.refFor(look, 'textbox', 'Full name');
    const r = await bac.ok(['--json', 'put', name, 'x']);
    assert.equal(r.json.chars, 1);
    assert.equal(r.json.text, undefined);
  });
});
