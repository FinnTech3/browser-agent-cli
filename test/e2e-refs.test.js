// Ref stability and staleness on a page that changes under the agent's feet.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './support/server.js';
import { Bac } from './support/cli.js';

let fx;
let bac;

before(async () => {
  fx = await startFixtureServer();
  bac = new Bac({ session: 'refs' });
  await bac.ok(['go', `${fx.origin}/list.html`]);
});

after(async () => {
  await bac.cleanup();
  await fx.close();
});

const refs = (out, role) => [...out.matchAll(new RegExp(`\\b(e\\d+) ${role} "([^"]*)"`, 'g'))].map((m) => ({ ref: m[1], name: m[2] }));

describe('list with dynamic changes', () => {
  let first;
  let doneRefs;

  it('assigns refs to every item and its Done button', async () => {
    first = (await bac.ok(['look'])).stdout;
    doneRefs = refs(first, 'button').filter((b) => b.name === 'Done');
    assert.equal(doneRefs.length, 3);
    assert.match(first, /e\d+ listitem "Buy milk"|e\d+ listitem\n\s+text "Buy milk"/);
    assert.match(first, /3 items/);
  });

  it('reports that an identical second look is unchanged and keeps refs stable', async () => {
    const again = (await bac.ok(['look'])).stdout;
    assert.match(again.split('\n')[0], /look #2: .*\(unchanged since last look\)/);
    assert.deepEqual(refs(again, 'button').filter((b) => b.name === 'Done'), doneRefs);
  });

  it('adds an item: existing refs stay, the new item gets fresh higher refs', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const input = Bac.refFor(out, 'textbox', 'New item');
    const add = Bac.refFor(out, 'button', 'Add');
    await bac.ok(['put', input, 'Water plants']);
    await bac.ok(['tap', add]);
    const after = (await bac.ok(['look'])).stdout;
    assert.match(after, /4 items/);
    const doneAfter = refs(after, 'button').filter((b) => b.name === 'Done');
    assert.equal(doneAfter.length, 4);
    assert.deepEqual(doneAfter.slice(0, 3), doneRefs);
    const maxOld = Math.max(...[...first.matchAll(/\be(\d+) /g)].map((m) => Number(m[1])));
    assert.ok(Number(doneAfter[3].ref.slice(1)) > maxOld);
  });

  it('removes an item: acting on its ref reports a stale ref (exit 3), others still work', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const [firstDone, secondDone] = refs(out, 'button').filter((b) => b.name === 'Done');
    await bac.ok(['tap', firstDone.ref]);
    const stale = await bac.run(['tap', firstDone.ref]);
    assert.equal(stale.code, 3);
    assert.match(stale.stderr, /error\[stale_ref\]: ref e\d+ is stale: its element was removed from the page\. Run: bac look/);
    const fine = await bac.run(['tap', secondDone.ref]);
    assert.equal(fine.code, 0);
    assert.match((await bac.ok(['look'])).stdout, /2 items/);
  });

  it('a page that rebuilds its DOM makes every old ref stale', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const remaining = refs(out, 'button').filter((b) => b.name === 'Done');
    const rebuild = Bac.refFor(out, 'button', 'Rebuild list');
    await bac.ok(['tap', rebuild]);
    for (const b of remaining) {
      const r = await bac.run(['tap', b.ref]);
      assert.equal(r.code, 3, b.ref);
    }
    const fresh = (await bac.ok(['look'])).stdout;
    const newDone = refs(fresh, 'button').filter((b) => b.name === 'Done');
    assert.equal(newDone.length, remaining.length);
    assert.ok(newDone.every((b) => !remaining.some((o) => o.ref === b.ref)));
    assert.equal((await bac.run(['tap', newDone[0].ref])).code, 0);
  });

  it('a ref that was never issued is a different error from a stale one', async () => {
    const r = await bac.run(['tap', 'e99999']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /^error\[unknown_ref\]: ref e99999 was never issued/);
    const junk = await bac.run(['tap', 'submit-button']);
    assert.equal(junk.code, 2);
    assert.match(junk.stderr, /not an element ref/);
  });
});

describe('scoping the snapshot', () => {
  it('--within a ref shows only that region', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const list = Bac.refFor(out, 'list', 'Items');
    const scoped = (await bac.ok(['look', '--within', list])).stdout;
    assert.match(scoped, /list "Items"/);
    assert.match(scoped, /button "Done"/);
    assert.doesNotMatch(scoped, /textbox "New item"/);
    assert.doesNotMatch(scoped, /heading/);
  });

  it('--within a CSS selector works, and a missing one is exit 4', async () => {
    const scoped = (await bac.ok(['look', '--within', 'form#add'])).stdout;
    assert.match(scoped, /textbox "New item"/);
    assert.doesNotMatch(scoped, /button "Rebuild list"/);
    const missing = await bac.run(['look', '--within', '#nope']);
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /error\[not_found\]/);
  });

  it('--actions lists only controls, each with its context', async () => {
    const out = (await bac.ok(['look', '--actions'])).stdout;
    assert.doesNotMatch(out, /heading|text "/);
    assert.match(out, /button "Done" {2}\(in listitem "[^"]+"\)/);
    assert.match(out, /textbox "New item" {2}\(in form "Add item"\)/);
  });

  it('--limit truncates and says how to see more', async () => {
    const out = (await bac.ok(['look', '--limit', '10'])).stdout;
    assert.match(out.split('\n')[0], /truncated/);
    assert.match(out, /note: output was cut off/);
  });
});

describe('refs across tabs and navigation', () => {
  it('a ref from another tab is stale in the active tab', async () => {
    const out = (await bac.ok(['look'])).stdout;
    const add = Bac.refFor(out, 'button', 'Add');
    await bac.ok(['tabs', 'new', `${fx.origin}/form.html`]);
    const r = await bac.run(['tap', add]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /another tab/);
    await bac.ok(['tabs', 'use', '1']);
    assert.equal((await bac.run(['tap', add])).code, 0);
  });
});
