/* global window, document */
// One browser session: a Chromium instance, its tabs, and every command that
// acts on them. Used only inside the daemon.

import crypto from 'node:crypto';
import { BacError } from './errors.js';
import { checkLoadedUrl, checkUrl } from './policy.js';
import { pageOp } from './page-script.js';
import { matchOptions } from './options.js';
import { parseRef, refProblem, requireRef } from './refs.js';
import { loadPlaywright } from './pw.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NET_ERRORS = {
  ERR_CONNECTION_REFUSED: 'connection refused',
  ERR_NAME_NOT_RESOLVED: 'host name not found',
  ERR_CONNECTION_TIMED_OUT: 'connection timed out',
  ERR_CONNECTION_RESET: 'connection reset',
  ERR_ADDRESS_UNREACHABLE: 'address unreachable',
  ERR_INTERNET_DISCONNECTED: 'no network connection',
  ERR_TOO_MANY_REDIRECTS: 'too many redirects',
  ERR_ABORTED: 'navigation was aborted',
  ERR_BLOCKED_BY_CLIENT: 'request was blocked',
  ERR_EMPTY_RESPONSE: 'server sent an empty response',
  ERR_INVALID_URL: 'invalid URL',
};

function netErrorText(code) {
  if (NET_ERRORS[code]) return NET_ERRORS[code];
  if (code.startsWith('ERR_CERT') || code.startsWith('ERR_SSL')) return 'TLS certificate or handshake error';
  return code.toLowerCase().replace(/^err_/, '').replace(/_/g, ' ');
}

export class Session {
  #browser;
  #context;
  #allow;
  #tabs = new Map();
  #activeId = null;
  #nextTabId = 1;
  #issued = 0;
  #looks = 0;
  #notes = [];
  #blocked = [];
  #quietAdopt = false;
  #closed = false;
  #refusedPopups = []; // timestamps of refused popup navigations not yet matched to a tab

  static async launch({ allow = null, onDisconnect = () => {} } = {}) {
    let browser;
    try {
      browser = await loadPlaywright().chromium.launch({ headless: true });
    } catch (err) {
      const first = String(err.message).split('\n')[0];
      if (err.code === 'MODULE_NOT_FOUND') {
        throw new BacError(
          'daemon_unavailable',
          'the playwright package is missing next to bac. Reinstall: npm install -g github:FinnTech3/browser-agent-cli',
        );
      }
      throw new BacError(
        'daemon_unavailable',
        `browser failed to launch: ${first}. Install Chromium with: npx playwright@1.63.0 install chromium`,
      );
    }
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    const session = new Session(browser, context, allow);
    browser.on('disconnected', () => {
      if (!session.#closed) onDisconnect();
    });
    await session.#init();
    return session;
  }

  constructor(browser, context, allow) {
    this.#browser = browser;
    this.#context = context;
    this.#allow = allow;
  }

  async #init() {
    await this.#context.route('**/*', async (route) => {
      try {
        const request = route.request();
        if (request.isNavigationRequest()) {
          const verdict = checkLoadedUrl(request.url(), this.#allow);
          if (!verdict.ok) {
            // A blocked top-level navigation fails its command; a blocked
            // sub-frame is only mentioned.
            // The first request of a new popup has no frame yet; that one is top-level.
            let fatal = true;
            let page = null;
            try {
              const frame = request.frame();
              fatal = frame.parentFrame() === null;
              page = frame.page();
            } catch {
              // popup: frame not created yet
            }
            this.#blocked.push({ error: verdict.error, fatal });
            // ERR_ABORTED cancels the navigation and leaves the current page in place.
            await route.abort('aborted');
            if (fatal) await this.#closeEmptyPopup(page);
            return;
          }
        }
      } catch {
        // Could not inspect the request; fall through and let it proceed.
      }
      await route.continue().catch(() => {
        // The page or the request is already gone.
      });
    });
    this.#context.on('page', (page) => {
      this.#refusedPopups = this.#refusedPopups.filter((at) => Date.now() - at < 3000);
      if (this.#refusedPopups.length > 0) {
        // Its first navigation was already refused: never list it as a tab.
        this.#refusedPopups.shift();
        this.#notes.push('a popup to a blocked address was closed');
        page.close().catch(() => {});
        return;
      }
      const tab = this.#adopt(page, this.#activeId);
      this.#activeId = tab.id;
      if (!this.#quietAdopt) this.#notes.push(`a new tab opened (tab ${tab.id}) and is now active`);
    });
    this.#quietAdopt = true;
    await this.#context.newPage();
    this.#quietAdopt = false;
  }

  get allow() {
    return this.#allow;
  }

  info() {
    return {
      browser: `chromium ${this.#browser.version()}`,
      tabs: this.#tabs.size,
      activeTab: this.#activeId,
      allow: this.#allow,
      looks: this.#looks,
      refsIssued: this.#issued,
    };
  }

  async close() {
    this.#closed = true;
    try {
      await this.#browser.close();
    } catch {
      // already closed
    }
  }

  // ------------------------------------------------------------------ tabs
  #adopt(page, openerId = null) {
    const tab = { id: this.#nextTabId++, page, lastHash: null, openerId, loadedOnce: false };
    this.#tabs.set(tab.id, tab);
    page.on('close', () => {
      this.#tabs.delete(tab.id);
      if (this.#activeId === tab.id) {
        const ids = [...this.#tabs.keys()];
        // Prefer the tab that opened this one.
        this.#activeId = this.#tabs.has(tab.openerId) ? tab.openerId : ids.length ? ids[ids.length - 1] : null;
      }
    });
    page.on('crash', () => {
      this.#notes.push(`tab ${tab.id} crashed and was closed`);
      page.close().catch(() => {});
    });
    page.on('dialog', (dialog) => {
      const kind = dialog.type();
      this.#notes.push(`a ${kind} dialog was ${kind === 'beforeunload' ? 'accepted' : 'dismissed'} automatically`);
      (kind === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (url !== 'about:blank') tab.loadedOnce = true;
      if (url.startsWith('chrome-error://')) return;
      const verdict = checkLoadedUrl(url, this.#allow);
      if (!verdict.ok) {
        // A redirect can reach a forbidden host after the request was allowed.
        // The document is already committed, so reset the tab.
        const error = new BacError('blocked_url', `${verdict.error.message}. The tab was reset to about:blank`);
        this.#blocked.push({ error, fatal: true });
        page.goto('about:blank').catch(() => {});
      }
    });
    return tab;
  }

  // A popup whose very first navigation was refused would stay behind as an
  // empty active tab. Close it so the opener becomes active again. The popup
  // may not be announced as a tab yet; then the next new tab is the one.
  async #closeEmptyPopup(page) {
    const isEmptyPopup = (t) => t.openerId !== null && !t.loadedOnce && t.page.url() === 'about:blank';
    const tabs = [...this.#tabs.values()];
    const tab = page ? tabs.find((t) => t.page === page) : tabs.reverse().find(isEmptyPopup);
    if (!tab) {
      if (!page) this.#refusedPopups.push(Date.now());
      return;
    }
    if (isEmptyPopup(tab)) {
      this.#notes.push('a popup to a blocked address was closed');
      await tab.page.close().catch(() => {});
    }
  }

  async #tab() {
    if (this.#tabs.size === 0) {
      this.#quietAdopt = true;
      try {
        await this.#context.newPage();
      } finally {
        this.#quietAdopt = false;
      }
      this.#notes.push('all tabs were closed; opened a fresh blank tab');
    }
    const tab = this.#tabs.get(this.#activeId) ?? [...this.#tabs.values()].pop();
    this.#activeId = tab.id;
    return tab;
  }

  // ------------------------------------------------------------- execution
  async exec(cmd, params = {}, timeoutMs = 10000) {
    const ctx = { deadline: Date.now() + timeoutMs, timeoutMs, cmd, ref: null };
    // Blocks that happened between commands become notes, not errors.
    for (const block of this.#blocked.splice(0)) this.#notes.push(block.error.message);
    let data;
    try {
      data = await this.#dispatch(cmd, params, ctx);
    } catch (err) {
      throw this.#translate(err, ctx);
    }
    const blocks = this.#blocked.splice(0);
    const fatal = blocks.find((b) => b.fatal);
    if (fatal) throw fatal.error;
    for (const block of blocks) this.#notes.push(block.error.message);
    data.notes = this.#notes.splice(0).slice(0, 10);
    return data;
  }

  #remaining(ctx) {
    return Math.max(1, ctx.deadline - Date.now());
  }

  #translate(err, ctx) {
    const blocks = this.#blocked.splice(0);
    const fatal = blocks.find((b) => b.fatal);
    if (fatal && !(err instanceof BacError && err.code === 'usage')) return fatal.error;
    if (err instanceof BacError) return err;
    const message = String(err?.message ?? err);
    const first = message.split('\n')[0].trim();
    const ref = ctx.ref;
    const who = ref ?? 'the element';

    const net = /net::(ERR_[A-Z0-9_]+)/.exec(message);
    if (net) {
      return new BacError(
        'nav_failed',
        `navigation failed: ${netErrorText(net[1])} (${net[1]}). Check the URL and that the server is running`,
      );
    }
    if (err?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(message)) {
      if (/intercepts pointer events/.test(message)) {
        return new BacError(
          'obscured',
          `${who} is covered by another element (overlay, banner or dialog). Dismiss it, then run: bac look`,
        );
      }
      if (/element is not visible/.test(message)) {
        return new BacError('not_visible', `${who} is not visible. Scroll it into view or open its container, then run: bac look`);
      }
      if (/element is not enabled/.test(message)) {
        return new BacError('not_enabled', `${who} is disabled. Complete the form first, then run: bac look`);
      }
      if (/not editable|readonly/i.test(message)) {
        return new BacError('not_fillable', `${who} is read-only and cannot be filled`);
      }
      const what = ctx.cmd === 'go' || ctx.cmd === 'back' ? 'the page to load' : `command "${ctx.cmd}"`;
      return new BacError(
        'timeout',
        `timed out after ${ctx.timeoutMs}ms waiting for ${what}. Run: bac look to see the current state, or retry with a larger --timeout`,
      );
    }
    if (/Element is not an <input>|not an <input>|Cannot type text into input\[type=/i.test(message)) {
      return new BacError('not_fillable', `${who} cannot be filled with text. Use tap, pick or key for this control`);
    }
    if (/Unknown key|Keyboard\.press/i.test(message)) {
      return new BacError('usage', `unknown key. Use names such as Enter, Tab, Escape, ArrowDown or Control+a`);
    }
    if (/Execution context was destroyed|not attached|detached|Frame was detached/i.test(message)) {
      return new BacError('stale_ref', 'the page changed while the command was running. Run: bac look');
    }
    if (/Target (page, context or browser )?(has been )?closed|Browser has been closed|has been closed|Target crashed|Page crashed|browser has disconnected/i.test(message)) {
      return new BacError('browser_lost', 'the tab or browser went away during the command. Run: bac status, then retry');
    }
    if (/Unexpected token|SyntaxError|not a valid selector|Unknown engine/i.test(message)) {
      return new BacError('usage', 'invalid CSS selector');
    }
    return new BacError('internal', `unexpected failure: ${first}`);
  }

  async #bounded(promise, ctx) {
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new BacError('timeout', `timed out after ${ctx.timeoutMs}ms. Retry with a larger --timeout`)),
        this.#remaining(ctx),
      );
    });
    try {
      return await Promise.race([promise, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #dispatch(cmd, p, ctx) {
    switch (cmd) {
      case 'go': return this.#go(p, ctx);
      case 'look': return this.#look(p, ctx);
      case 'tap': return this.#tap(p, ctx);
      case 'put': return this.#put(p, ctx);
      case 'key': return this.#key(p, ctx);
      case 'pick': return this.#pick(p, ctx);
      case 'scroll': return this.#scroll(p, ctx);
      case 'text': return this.#text(p, ctx);
      case 'until': return this.#until(p, ctx);
      case 'shot': return this.#shot(p, ctx);
      case 'tabs': return this.#tabsCmd(p, ctx);
      case 'back': return this.#back(ctx);
      default:
        throw new BacError('usage', `unknown command "${String(cmd).slice(0, 30)}"`);
    }
  }

  // ----------------------------------------------------------- page helpers
  async #loaded(page, ctx) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(this.#remaining(ctx), 5000) });
    } catch {
      // keep going with whatever the page has
    }
  }

  // After an action: give navigations and new tabs a moment to appear, then
  // wait for the active tab to finish loading. Returns the active tab.
  // `watch` says what to wait for: how many tabs existed before
  // and how long to keep looking for it. Only a link that targets a new tab is waited for.
  async #afterAction(ctx, watch = null) {
    await sleep(60);
    if (watch) {
      const until = Date.now() + watch.maxMs;
      while (Date.now() < until && this.#tabs.size <= watch.tabsBefore) await sleep(25);
    }
    const tab = await this.#tab();
    try {
      await tab.page.waitForLoadState('load', { timeout: Math.min(this.#remaining(ctx), 3000) });
    } catch {
      // a slow sub-resource must not fail the action
    }
    this.#guardLoaded(tab.page);
    return tab;
  }

  #guardLoaded(page) {
    if (page.url().startsWith('chrome-error://')) return;
    const verdict = checkLoadedUrl(page.url(), this.#allow);
    if (!verdict.ok) {
      page.goto('about:blank').catch(() => {});
      this.#blocked.length = 0;
      throw verdict.error;
    }
  }

  async #retryOnNav(fn) {
    let last;
    for (let i = 0; i < 3; i += 1) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        if (!/Execution context was destroyed|navigat/i.test(String(err?.message))) throw err;
        await sleep(100);
      }
    }
    throw last;
  }

  async #resolve(tab, ref, ctx) {
    const clean = requireRef(ref);
    ctx.ref = clean;
    const handle = await this.#retryOnNav(() =>
      tab.page.evaluateHandle(pageOp, { op: 'resolve', args: { ref: clean } }),
    );
    const el = handle.asElement();
    if (el) return el;
    const status = await handle.jsonValue().catch(() => 'missing');
    await handle.dispose().catch(() => {});
    throw refProblem(clean, this.#issued, status);
  }

  async #withElement(tab, ref, ctx, fn) {
    const el = await this.#resolve(tab, ref, ctx);
    try {
      return await fn(el);
    } finally {
      el.dispose().catch(() => {});
    }
  }

  async #requireUsable(el, ref, { needEnabled = true } = {}) {
    if (!(await el.isVisible())) {
      throw new BacError('not_visible', `${ref} is not visible. Scroll it into view or open its container, then run: bac look`);
    }
    if (needEnabled && !(await el.isEnabled())) {
      throw new BacError('not_enabled', `${ref} is disabled. Complete the form first, then run: bac look`);
    }
  }

  #here(tab) {
    return { url: tab.page.url(), tab: tab.id };
  }

  // --------------------------------------------------------------- commands
  async #go(p, ctx) {
    const href = checkUrl(p.url, this.#allow);
    const tab = await this.#tab();
    const response = await tab.page.goto(href, {
      waitUntil: p.wait || 'load',
      timeout: this.#remaining(ctx),
    });
    this.#guardLoaded(tab.page);
    const status = response ? response.status() : null;
    if (status && status >= 400) this.#notes.push(`the server answered HTTP ${status}`);
    return { ...this.#here(tab), status };
  }

  async #back(ctx) {
    const tab = await this.#tab();
    const before = tab.page.url();
    const response = await tab.page.goBack({ waitUntil: 'load', timeout: this.#remaining(ctx) });
    if (!response && tab.page.url() === before) {
      throw new BacError('no_history', 'there is no earlier page in this tab history');
    }
    this.#guardLoaded(tab.page);
    return this.#here(tab);
  }

  async #look(p, ctx) {
    const tab = await this.#tab();
    await this.#loaded(tab.page, ctx);
    let rootHandle = null;
    try {
      if (p.within) {
        if (parseRef(p.within) !== null) {
          rootHandle = await this.#resolve(tab, p.within, ctx);
        } else {
          try {
            rootHandle = await tab.page.$(p.within);
          } catch {
            throw new BacError('usage', 'invalid CSS selector for --within');
          }
          if (!rootHandle) throw new BacError('not_found', 'nothing matches the --within selector');
        }
      }
      const res = await this.#bounded(
        this.#retryOnNav(() =>
          tab.page.evaluate(pageOp, {
            op: 'tree',
            args: { startRef: this.#issued, limit: p.limit ?? 500, actionsOnly: !!p.actionsOnly, root: rootHandle },
          }),
        ),
        ctx,
      );
      this.#issued = Math.max(this.#issued, res.nextRef);
      const refs = [];
      collectRefs(res.tree, refs);
      const hash = crypto.createHash('sha1').update(JSON.stringify(res.tree)).digest('hex');
      const unchanged = tab.lastHash === hash && !p.within;
      if (!p.within) tab.lastHash = hash;
      this.#looks += 1;
      return {
        snapshot: this.#looks,
        url: res.url,
        title: res.title,
        tree: res.tree,
        count: res.count,
        truncated: res.truncated,
        unchanged,
        firstRef: refs.length ? `e${Math.min(...refs)}` : null,
        lastRef: refs.length ? `e${Math.max(...refs)}` : null,
        tab: tab.id,
        untrusted: true,
      };
    } finally {
      rootHandle?.dispose().catch(() => {});
    }
  }

  async #tap(p, ctx) {
    const tab = await this.#tab();
    const tabsBefore = this.#tabs.size;
    const before = tab.page.url();
    let opensTab = false;
    await this.#withElement(tab, p.ref, ctx, async (el) => {
      await this.#requireUsable(el, ctx.ref);
      opensTab = await el
        .evaluate((node) => node.closest('a')?.target === '_blank')
        .catch(() => false);
      await el.click({ timeout: this.#remaining(ctx) });
    });
    const now = await this.#afterAction(ctx, opensTab ? { tabsBefore, maxMs: 2000 } : null);
    return {
      ref: p.ref,
      ...this.#here(now),
      navigated: now.id !== tab.id || now.page.url() !== before,
      newTab: this.#tabs.size > tabsBefore,
    };
  }

  async #put(p, ctx) {
    const tab = await this.#tab();
    const info = await this.#withElement(tab, p.ref, ctx, async (el) => {
      await this.#requireUsable(el, ctx.ref);
      const secret = await tab.page.evaluate(pageOp, { op: 'secret', args: { root: el } });
      await el.fill(p.text, { timeout: this.#remaining(ctx) });
      return { secret };
    });
    return { ref: p.ref, chars: [...p.text].length, secretField: info.secret, ...this.#here(await this.#tab()) };
  }

  async #key(p, ctx) {
    const tab = await this.#tab();
    const before = tab.page.url();
    if (p.on) {
      await this.#withElement(tab, p.on, ctx, async (el) => {
        await this.#requireUsable(el, ctx.ref, { needEnabled: false });
        await el.press(p.key, { timeout: this.#remaining(ctx) });
      });
    } else {
      await tab.page.keyboard.press(p.key);
    }
    const now = await this.#afterAction(ctx);
    return { key: p.key, ...this.#here(now), navigated: now.page.url() !== before };
  }

  async #pick(p, ctx) {
    const tab = await this.#tab();
    const count = await this.#withElement(tab, p.ref, ctx, async (el) => {
      await this.#requireUsable(el, ctx.ref);
      const isSelect = await el.evaluate((n) => n.tagName === 'SELECT');
      if (!isSelect) throw new BacError('not_fillable', `${ctx.ref} is not a select control. Use tap for custom dropdowns`);
      const options = await el.evaluate((n) =>
        Array.from(n.options).map((o) => ({ label: o.label || o.textContent || '', value: o.value, disabled: o.disabled })),
      );
      const indexes = matchOptions(options, p.options, ctx.ref);
      const multiple = await el.evaluate((n) => n.multiple);
      if (indexes.length > 1 && !multiple) {
        throw new BacError('usage', `${ctx.ref} accepts a single choice, but ${indexes.length} were given`);
      }
      await el.selectOption(indexes.map((index) => ({ index })), { timeout: this.#remaining(ctx) });
      return indexes.length;
    });
    return { ref: p.ref, picked: count, ...this.#here(await this.#tab()) };
  }

  async #scroll(p, ctx) {
    const tab = await this.#tab();
    const where = p.where;
    if (parseRef(where) !== null) {
      await this.#withElement(tab, where, ctx, async (el) => {
        await el.scrollIntoViewIfNeeded({ timeout: this.#remaining(ctx) });
      });
    } else {
      await this.#bounded(
        tab.page.evaluate(
          ({ dir, px }) => {
            const step = px || Math.round(window.innerHeight * 0.8);
            if (dir === 'down') window.scrollBy(0, step);
            else if (dir === 'up') window.scrollBy(0, -step);
            else if (dir === 'top') window.scrollTo(0, 0);
            else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
          },
          { dir: where, px: p.px ?? null },
        ),
        ctx,
      );
    }
    const pos = await tab.page.evaluate(() => ({
      y: Math.round(window.scrollY),
      max: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)),
    }));
    return { where, ...pos, atTop: pos.y <= 0, atBottom: pos.y >= pos.max };
  }

  async #text(p, ctx) {
    const tab = await this.#tab();
    await this.#loaded(tab.page, ctx);
    const max = p.max ?? 8000;
    const read = (root) =>
      this.#bounded(
        this.#retryOnNav(() => tab.page.evaluate(pageOp, { op: 'text', args: { root, max } })),
        ctx,
      );
    const result = p.ref ? await this.#withElement(tab, p.ref, ctx, read) : await read(null);
    return { ...result, ref: p.ref ?? null, tab: tab.id, untrusted: true };
  }

  async #until(p, ctx) {
    const tab = await this.#tab();
    const started = Date.now();
    const timeout = this.#remaining(ctx);
    const label = String(p.value ?? '').slice(0, 60);
    try {
      switch (p.kind) {
        case 'text':
          await tab.page.waitForFunction(
            (needle) => (document.body?.innerText || '').includes(needle),
            p.value,
            { timeout, polling: 100 },
          );
          break;
        case 'gone':
          await tab.page.waitForFunction(
            (needle) => !(document.body?.innerText || '').includes(needle),
            p.value,
            { timeout, polling: 100 },
          );
          break;
        case 'css':
          await tab.page.waitForSelector(p.value, { state: p.hidden ? 'hidden' : 'visible', timeout });
          break;
        case 'url':
          await tab.page.waitForURL((u) => u.href.includes(p.value), { timeout });
          break;
        case 'idle':
          await tab.page.waitForLoadState('networkidle', { timeout });
          break;
        default:
          throw new BacError('usage', `unknown wait kind "${String(p.kind).slice(0, 20)}". Use text, gone, css, url or idle`);
      }
    } catch (err) {
      if (err instanceof BacError) throw err;
      if (err?.name === 'TimeoutError') {
        const what = p.kind === 'idle' ? 'the network to go idle' : `${p.kind} "${label}"`;
        throw new BacError(
          'timeout',
          `timed out after ${ctx.timeoutMs}ms waiting for ${what}. Run: bac look to see the current state, or retry with a larger --timeout`,
        );
      }
      throw err;
    }
    return { kind: p.kind, waitedMs: Date.now() - started, ...this.#here(tab) };
  }

  async #shot(p, ctx) {
    const tab = await this.#tab();
    const options = { type: p.type, timeout: this.#remaining(ctx), animations: 'disabled' };
    let bytes;
    if (p.ref) {
      bytes = await this.#withElement(tab, p.ref, ctx, (el) => el.screenshot(options));
    } else {
      bytes = await tab.page.screenshot({ ...options, fullPage: !!p.full });
    }
    return { base64: bytes.toString('base64'), bytes: bytes.length, type: p.type, ...this.#here(tab) };
  }

  async #tabsCmd(p, ctx) {
    const list = async () => {
      const tabs = [];
      for (const tab of this.#tabs.values()) {
        let title = '';
        try {
          title = await tab.page.title();
        } catch {
          title = '';
        }
        tabs.push({ id: tab.id, url: tab.page.url(), title, active: tab.id === this.#activeId });
      }
      return { tabs, active: this.#activeId, untrusted: true };
    };
    const action = p.action || 'list';
    if (action === 'list') {
      await this.#tab();
      return list();
    }
    if (action === 'use') {
      const tab = this.#tabs.get(p.id);
      if (!tab) throw new BacError('not_found', `no tab ${p.id}. Run: bac tabs`);
      this.#activeId = tab.id;
      await tab.page.bringToFront();
      return { active: tab.id, ...this.#here(tab) };
    }
    if (action === 'new') {
      let href = null;
      if (p.url) href = checkUrl(p.url, this.#allow);
      this.#quietAdopt = true;
      let page;
      try {
        page = await this.#context.newPage();
      } finally {
        this.#quietAdopt = false;
      }
      const tab = [...this.#tabs.values()].find((t) => t.page === page);
      this.#activeId = tab.id;
      if (href) {
        await page.goto(href, { waitUntil: 'load', timeout: this.#remaining(ctx) });
        this.#guardLoaded(page);
      }
      return { active: tab.id, ...this.#here(tab) };
    }
    if (action === 'close') {
      const id = p.id ?? this.#activeId;
      const tab = this.#tabs.get(id);
      if (!tab) throw new BacError('not_found', `no tab ${id}. Run: bac tabs`);
      await tab.page.close();
      await this.#tab();
      return { closed: id, active: this.#activeId, tabs: this.#tabs.size };
    }
    throw new BacError('usage', 'tabs takes: list, use ID, new [URL], close [ID]');
  }
}

function collectRefs(nodes, out) {
  for (const node of nodes) {
    if (node.ref) out.push(Number(node.ref.slice(1)));
    if (node.children) collectRefs(node.children, out);
  }
}
