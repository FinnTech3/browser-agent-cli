/* global document */
// Tests for the in-page extractor, run in a real headless Chromium without the daemon.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaywright } from '../src/pw.js';
import { pageOp } from '../src/page-script.js';

let browser;

before(async () => {
  browser = await loadPlaywright().chromium.launch();
});

after(async () => {
  await browser.close();
});

async function withPage(html, fn) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><title>t</title><body>${html}</body>`);
    return await fn(page);
  } finally {
    await page.close();
  }
}

const tree = (page, args = {}) => page.evaluate(pageOp, { op: 'tree', args: { startRef: 0, limit: 500, ...args } });

function flat(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    if (n.children) flat(n.children, out);
  }
  return out;
}

const find = (res, role, name) => flat(res.tree).find((n) => n.role === role && (name === undefined || n.name === name));

describe('roles and names', () => {
  it('maps landmarks, headings, lists and links', () =>
    withPage(
      `<header><nav aria-label="Main"><a href="/a">Home</a></nav></header>
       <main><h2>Title</h2><ul><li>One</li><li>Two</li></ul></main><footer>bye</footer>`,
      async (page) => {
        const res = await tree(page);
        assert.ok(find(res, 'banner'));
        assert.equal(find(res, 'navigation').name, 'Main');
        assert.equal(find(res, 'link', 'Home').href, '/a');
        assert.deepEqual(
          { level: find(res, 'heading').level, name: find(res, 'heading').name },
          { level: 2, name: 'Title' },
        );
        assert.equal(find(res, 'list').children.length, 2);
        assert.equal(find(res, 'listitem', 'One').role, 'listitem');
        assert.ok(find(res, 'contentinfo'));
      },
    ));

  it('computes control names from label[for], wrapping labels, aria and placeholder', () =>
    withPage(
      `<label for="a">First</label><input id="a">
       <label>Second <input></label>
       <input aria-label="Third">
       <span id="lbl">Fourth</span><input aria-labelledby="lbl">
       <input placeholder="Fifth">
       <input name="sixth_field">
       <button><img alt="Seventh"></button>`,
      async (page) => {
        const res = await tree(page);
        const names = flat(res.tree).filter((n) => n.role === 'textbox' || n.role === 'button').map((n) => n.name);
        assert.deepEqual(names, ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'sixth_field', 'Seventh']);
      },
    ));

  it('does not repeat label text next to the control it names', () =>
    withPage(`<label for="x">Email</label><input id="x"><label><input type="checkbox"> Agree</label>`, async (page) => {
      const res = await tree(page);
      assert.equal(flat(res.tree).filter((n) => n.role === 'text').length, 0);
      assert.equal(find(res, 'checkbox').name, 'Agree');
    }));

  it('uses explicit roles and treats presentation as transparent', () =>
    withPage(
      `<div role="button" tabindex="0">Fake button</div><div role="presentation"><b>kept text</b></div>`,
      async (page) => {
        const res = await tree(page);
        assert.equal(find(res, 'button', 'Fake button').role, 'button');
        assert.ok(flat(res.tree).some((n) => n.role === 'text' && n.text === 'kept text'));
      },
    ));

  it('lists clickable divs but not their labels or containers of real controls', () =>
    withPage(
      `<div style="cursor:pointer" id="c1">Card one</div>
       <div style="cursor:pointer"><a href="/x">inside link</a></div>
       <label style="cursor:pointer" for="chk">Pointer label</label><input type="checkbox" id="chk">`,
      async (page) => {
        const res = await tree(page);
        assert.deepEqual(flat(res.tree).filter((n) => n.role === 'clickable').map((n) => n.name), ['Card one']);
      },
    ));
});

describe('states and values', () => {
  it('reports checked, disabled, required, expanded and focus', () =>
    withPage(
      `<input type="checkbox" checked aria-label="c1"><input type="checkbox" aria-label="c2">
       <input type="radio" aria-label="r1" checked>
       <button disabled>Off</button><input required aria-label="req">
       <button aria-expanded="true">Open</button><button aria-expanded="false">Shut</button>
       <details><summary>More</summary>body</details>
       <input aria-label="focused one" autofocus>`,
      async (page) => {
        await page.focus('[aria-label="focused one"]');
        const res = await tree(page);
        assert.deepEqual(find(res, 'checkbox', 'c1').flags, ['checked']);
        assert.deepEqual(find(res, 'checkbox', 'c2').flags, ['unchecked']);
        assert.deepEqual(find(res, 'radio', 'r1').flags, ['checked']);
        assert.deepEqual(find(res, 'button', 'Off').flags, ['disabled']);
        assert.deepEqual(find(res, 'textbox', 'req').flags, ['required']);
        assert.deepEqual(find(res, 'button', 'Open').flags, ['expanded']);
        assert.deepEqual(find(res, 'button', 'Shut').flags, ['collapsed']);
        assert.deepEqual(find(res, 'button', 'More').flags, ['collapsed']);
        assert.ok(find(res, 'textbox', 'focused one').flags.includes('focused'));
      },
    ));

  it('reports text values, select values and options', () =>
    withPage(
      `<input aria-label="name" value="Ada"><textarea aria-label="bio">Hello</textarea>
       <select aria-label="plan"><option>Free</option><option selected>Pro</option></select>
       <input type="range" aria-label="vol" value="7" min="0" max="10">`,
      async (page) => {
        const res = await tree(page);
        assert.equal(find(res, 'textbox', 'name').value, 'Ada');
        assert.equal(find(res, 'textbox', 'bio').value, 'Hello');
        const plan = find(res, 'combobox', 'plan');
        assert.equal(plan.value, 'Pro');
        assert.deepEqual(plan.options, ['Free', 'Pro']);
        assert.equal(find(res, 'slider', 'vol').value, '7');
      },
    ));

  it('redacts password-like fields and never returns their value', () =>
    withPage(
      `<input type="password" aria-label="p1" value="hunter2">
       <input name="apiToken" value="tok_live_abc" aria-label="k">
       <input autocomplete="one-time-code" value="123456" aria-label="otp">
       <input aria-label="Card number" value="4242424242424242">
       <input aria-label="Nickname" value="visible">`,
      async (page) => {
        const res = await tree(page);
        const json = JSON.stringify(res);
        for (const secret of ['hunter2', 'tok_live_abc', '123456', '4242424242424242']) {
          assert.ok(!json.includes(secret), secret);
        }
        assert.equal(find(res, 'textbox', 'p1').redacted, true);
        assert.equal(find(res, 'textbox', 'k').redacted, true);
        assert.equal(find(res, 'textbox', 'otp').redacted, true);
        assert.equal(find(res, 'textbox', 'Card number').redacted, true);
        assert.equal(find(res, 'textbox', 'Nickname').value, 'visible');
      },
    ));

  it('does not redact innocent look-alikes such as "passenger"', () =>
    withPage(`<input aria-label="Passenger name" value="Ada">`, async (page) => {
      const res = await tree(page);
      assert.equal(find(res, 'textbox').value, 'Ada');
    }));
});

describe('visibility and text', () => {
  it('skips hidden content, keeps visible children of invisible parents', () =>
    withPage(
      `<p hidden>hidden attr</p><p style="display:none">display none</p><p aria-hidden="true">aria hidden</p>
       <p style="visibility:hidden">invisible <span style="visibility:visible">shown child</span></p>
       <button style="width:0;height:0;padding:0;border:0">zero size</button>
       <script>var leak = "script text"</script><style>.x{}</style><p>ok</p>`,
      async (page) => {
        const res = await tree(page);
        const text = flat(res.tree).filter((n) => n.role === 'text').map((n) => n.text);
        assert.deepEqual(text, ['shown child', 'ok']);
        assert.equal(find(res, 'button'), undefined);
      },
    ));

  it('merges inline text and separates blocks', () =>
    withPage(`<div>Hello <b>big</b> world</div><div>Second</div><p>Third<br>Fourth</p>`, async (page) => {
      const res = await tree(page);
      assert.deepEqual(
        flat(res.tree).filter((n) => n.role === 'text').map((n) => n.text),
        ['Hello big world', 'Second', 'Third', 'Fourth'],
      );
    }));

  it('flattens open shadow roots and marks iframes as opaque', () =>
    withPage(
      `<div id="host"></div><iframe title="Ad slot" srcdoc="<p>inner</p>"></iframe>
       <script>
         const root = document.getElementById('host').attachShadow({ mode: 'open' });
         root.innerHTML = '<button>In shadow</button>';
       </script>`,
      async (page) => {
        const res = await tree(page);
        assert.ok(find(res, 'button', 'In shadow'));
        const frame = find(res, 'frame', 'Ad slot');
        assert.deepEqual(frame.flags, ['opaque']);
        assert.ok(!JSON.stringify(res).includes('inner'));
      },
    ));

  it('collapses text-only structural nodes into one line', () =>
    withPage(`<ul><li>Only text</li><li>Has <button>Btn</button></li></ul><table><tr><th>H</th><td>V</td></tr></table>`, async (page) => {
      const res = await tree(page);
      assert.equal(find(res, 'listitem', 'Only text').children, undefined);
      assert.equal(find(res, 'cell', 'V').role, 'cell');
      assert.equal(find(res, 'columnheader', 'H').role, 'columnheader');
    }));
});

describe('refs', () => {
  it('keeps refs stable across looks and numbers new elements after the old ones', () =>
    withPage(`<button id="a">A</button><button id="b">B</button>`, async (page) => {
      const first = await tree(page);
      const refA = find(first, 'button', 'A').ref;
      const refB = find(first, 'button', 'B').ref;
      assert.deepEqual([refA, refB], ['e1', 'e2']);
      await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<button id="c">C</button>'));
      const second = await tree(page, { startRef: first.nextRef });
      assert.equal(find(second, 'button', 'A').ref, refA);
      assert.equal(find(second, 'button', 'B').ref, refB);
      assert.equal(find(second, 'button', 'C').ref, 'e3');
      assert.equal(second.nextRef, 3);
    }));

  it('resolves refs to live elements and reports missing or removed ones', () =>
    withPage(`<button id="a">A</button><button id="b">B</button>`, async (page) => {
      const res = await tree(page);
      const ref = find(res, 'button', 'A').ref;
      const handle = await page.evaluateHandle(pageOp, { op: 'resolve', args: { ref } });
      assert.equal(await handle.evaluate((el) => el.id), 'a');
      await page.evaluate(() => document.getElementById('a').remove());
      const gone = await page.evaluateHandle(pageOp, { op: 'resolve', args: { ref } });
      assert.equal(await gone.jsonValue(), 'detached');
      const never = await page.evaluateHandle(pageOp, { op: 'resolve', args: { ref: 'e99' } });
      assert.equal(await never.jsonValue(), 'missing');
    }));

  it('a new document has an empty registry, so old refs stop resolving', async () => {
    const page = await browser.newPage();
    try {
      await page.route('http://fixture.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: `<button>${route.request().url().endsWith('one') ? 'A' : 'Z'}</button>` }),
      );
      await page.goto('http://fixture.test/one');
      const res = await tree(page);
      await page.goto('http://fixture.test/two');
      const handle = await page.evaluateHandle(pageOp, { op: 'resolve', args: { ref: find(res, 'button').ref } });
      assert.equal(await handle.jsonValue(), 'missing');
    } finally {
      await page.close();
    }
  });

  it('limits output and reports truncation', () =>
    withPage(`${'<p>line</p><button>b</button>'.repeat(30)}`, async (page) => {
      const res = await tree(page, { limit: 10 });
      assert.equal(res.truncated, true);
      assert.ok(res.count <= 11);
      const actions = await tree(page, { limit: 5, actionsOnly: true });
      assert.equal(actions.truncated, true);
      assert.equal(actions.interactive, 5);
    }));

  it('can scope to one element', () =>
    withPage(`<section aria-label="Left"><button>L</button></section><section aria-label="Right"><button>R</button></section>`, async (page) => {
      const root = await page.$('section[aria-label="Right"]');
      const res = await tree(page, { root });
      assert.deepEqual(flat(res.tree).map((n) => n.name), ['Right', 'R']);
    }));
});

describe('text op', () => {
  it('reads visible text, truncates, and never reveals secret field values', () =>
    withPage(
      `<p>Hello</p><p style="display:none">no</p><input id="pw" type="password" value="hunter2"><input id="n" value="plain">`,
      async (page) => {
        const all = await page.evaluate(pageOp, { op: 'text', args: { root: null, max: 3 } });
        assert.equal(all.text, 'Hel');
        assert.equal(all.truncated, true);
        const pw = await page.evaluate(pageOp, { op: 'text', args: { root: await page.$('#pw'), max: 100 } });
        assert.equal(pw.text, '[redacted]');
        const plain = await page.evaluate(pageOp, { op: 'text', args: { root: await page.$('#n'), max: 100 } });
        assert.equal(plain.text, 'plain');
      },
    ));
});
