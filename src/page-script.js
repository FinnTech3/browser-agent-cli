// Code that runs INSIDE the web page. Playwright serialises `pageOp` with
// toString(), so it must not reference anything outside its own body.
//
// Operations:
//   tree     build the accessibility-style tree and assign element refs
//   text     read visible text of an element or the whole page
//   resolve  map a ref back to its live element
//
// Refs live in a registry on the page's document. A navigation creates a new
// document, so refs from the old page simply stop resolving. That is how stale
// refs are detected.

export function pageOp(request) {
  const op = request.op;
  const args = request.args;
  const KEY = Symbol.for('browser-agent-cli.refs');

  function registry() {
    let reg = document[KEY];
    if (!reg) {
      reg = { byRef: new Map(), byEl: new WeakMap() };
      Object.defineProperty(document, KEY, { value: reg, enumerable: false });
    }
    return reg;
  }

  const tagOf = (el) => el.tagName.toUpperCase();

  // ---------------------------------------------------------------- secrets
  const SECRET_WORDS = [
    /(^|[^a-z])pass(word|wd|phrase|code)?($|[^a-z])/,
    /(^|[^a-z])pwd($|[^a-z])/,
    /secret/,
    /token/,
    /api[ _-]?key/,
    /(^|[^a-z])(cvv|cvc|ssn|otp|pin)($|[^a-z])/,
    /card[ _-]?number/,
    /one[ _-]?time/,
  ];
  const SECRET_AUTOCOMPLETE = /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/;

  function looksSecretText(s) {
    if (!s) return false;
    const spaced = String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return SECRET_WORDS.some((re) => re.test(spaced));
  }

  function isSecretField(el) {
    if (tagOf(el) !== 'INPUT' && tagOf(el) !== 'TEXTAREA') return false;
    if (tagOf(el) === 'INPUT' && (el.type || '').toLowerCase() === 'password') return true;
    if (SECRET_AUTOCOMPLETE.test((el.getAttribute('autocomplete') || '').toLowerCase())) return true;
    return (
      looksSecretText(el.getAttribute('name')) ||
      looksSecretText(el.id) ||
      looksSecretText(el.getAttribute('aria-label')) ||
      looksSecretText(el.getAttribute('placeholder'))
    );
  }

  // ------------------------------------------------------------------ utils
  const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

  function childrenOf(node) {
    if (node.nodeType === 1) {
      if (tagOf(node) === 'SLOT') {
        const assigned = node.assignedNodes({ flatten: true });
        return assigned.length ? assigned : Array.from(node.childNodes);
      }
      if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    }
    return Array.from(node.childNodes);
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'DATALIST', 'OPTION', 'OPTGROUP']);

  function isHiddenSubtree(el) {
    if (SKIP_TAGS.has(tagOf(el))) return true;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return true;
    return getComputedStyle(el).display === 'none';
  }

  // Text used for accessible names: visible descendant text, image alt text.
  function nameFromContent(el, depth = 0) {
    if (depth > 12) return '';
    let out = '';
    for (const child of childrenOf(el)) {
      if (out.length > 600) break;
      if (child.nodeType === 3) {
        out += child.data;
      } else if (child.nodeType === 1) {
        if (isHiddenSubtree(child)) continue;
        const tag = tagOf(child);
        if (tag === 'IMG') {
          out += ` ${child.getAttribute('alt') || ''} `;
        } else if (tag === 'INPUT') {
          const type = (child.type || '').toLowerCase();
          if (type === 'button' || type === 'submit' || type === 'reset') out += ` ${child.value} `;
        } else {
          const cs = getComputedStyle(child);
          const block = !cs.display.startsWith('inline');
          const inner = nameFromContent(child, depth + 1);
          out += block ? ` ${inner} ` : inner;
        }
      }
    }
    return collapse(out);
  }

  function labelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    const root = el.getRootNode();
    const parts = [];
    for (const id of ids) {
      const target = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
      if (target) parts.push(collapse(target.textContent || ''));
    }
    return collapse(parts.join(' '));
  }

  function labelsText(el) {
    if (!el.labels || el.labels.length === 0) return '';
    return collapse(Array.from(el.labels).map((l) => nameFromContent(l)).join(' '));
  }

  // ------------------------------------------------------------------ roles
  const KNOWN_ROLES = new Set([
    'alert', 'alertdialog', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader',
    'combobox', 'complementary', 'contentinfo', 'dialog', 'figure', 'form', 'grid', 'gridcell',
    'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee',
    'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation',
    'option', 'progressbar', 'radio', 'region', 'row', 'rowheader', 'search', 'searchbox',
    'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist',
    'tabpanel', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treeitem',
  ]);

  const INTERACTIVE = new Set([
    'link', 'button', 'checkbox', 'radio', 'switch', 'textbox', 'searchbox', 'combobox',
    'listbox', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'option', 'treeitem', 'clickable',
  ]);

  // Interactive roles whose accessible name comes from their own content.
  const NAME_FROM_CONTENT = new Set([
    'link', 'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'treeitem', 'clickable', 'switch', 'checkbox', 'radio',
  ]);

  // Roles that carry no information when empty.
  const KEEP_WHEN_EMPTY = new Set(['img', 'separator', 'progressbar', 'meter']);

  const TAG_ROLES = {
    NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary', ARTICLE: 'article', DIALOG: 'dialog',
    UL: 'list', OL: 'list', MENU: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell',
    HR: 'separator', PROGRESS: 'progressbar', METER: 'meter', OUTPUT: 'status', DETAILS: 'group',
    FIELDSET: 'group', FIGURE: 'figure', BLOCKQUOTE: 'blockquote', SEARCH: 'search',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    SUMMARY: 'button', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', IMG: 'img',
    IFRAME: 'frame',
  };

  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
  };

  function sectioningAncestor(el) {
    return !!el.closest('article, aside, main, nav, section');
  }

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (explicit === 'presentation' || explicit === 'none') return null;
    if (explicit && KNOWN_ROLES.has(explicit)) return explicit;
    const tag = tagOf(el);
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (INPUT_ROLES[type]) return INPUT_ROLES[type];
      if (el.hasAttribute('list')) return 'combobox';
      return 'textbox';
    }
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'TH') return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    if (tag === 'IMG') return el.hasAttribute('alt') && el.getAttribute('alt') === '' ? null : 'img';
    if (tag === 'HEADER') return sectioningAncestor(el) ? null : 'banner';
    if (tag === 'FOOTER') return sectioningAncestor(el) ? null : 'contentinfo';
    if (tag === 'FORM') return 'form';
    if (tag === 'SECTION') {
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'inherit' && el.hasAttribute('contenteditable')) {
      return 'textbox';
    }
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    return null;
  }

  function nameOf(el, role) {
    const labelled = labelledByText(el);
    if (labelled) return labelled;
    const aria = collapse(el.getAttribute('aria-label') || '');
    if (aria) return aria;
    const tag = tagOf(el);
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      const label = labelsText(el);
      if (label) return label;
      if (type === 'submit') return el.value || 'Submit';
      if (type === 'reset') return el.value || 'Reset';
      if (type === 'button') return el.value || '';
      if (type === 'image') return el.getAttribute('alt') || el.value || '';
      if (type === 'file') return 'Choose file';
    } else if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'METER' || tag === 'PROGRESS' || tag === 'OUTPUT') {
      const label = labelsText(el);
      if (label) return label;
    } else if (tag === 'IMG' || tag === 'AREA') {
      const alt = el.getAttribute('alt');
      if (alt) return collapse(alt);
    } else if (tag === 'FIELDSET') {
      const legend = el.querySelector(':scope > legend');
      if (legend) return nameFromContent(legend);
    } else if (tag === 'TABLE') {
      const caption = el.querySelector(':scope > caption');
      if (caption) return nameFromContent(caption);
    } else if (tag === 'FIGURE') {
      const cap = el.querySelector(':scope > figcaption');
      if (cap) return nameFromContent(cap);
    }
    if (NAME_FROM_CONTENT.has(role) && tag !== 'INPUT') {
      const content = nameFromContent(el);
      if (content) return content;
    }
    const title = collapse(el.getAttribute('title') || '');
    if (title) return title;
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      const ph = collapse(el.getAttribute('placeholder') || '');
      if (ph) return ph;
    }
    return '';
  }

  const attrTrue = (el, name) => el.getAttribute(name) === 'true';

  function flagsOf(el, role) {
    const flags = [];
    const tag = tagOf(el);
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      if (tag === 'INPUT') {
        flags.push(el.indeterminate ? 'mixed' : el.checked ? 'checked' : 'unchecked');
      } else {
        const v = el.getAttribute('aria-checked');
        flags.push(v === 'mixed' ? 'mixed' : v === 'true' ? 'checked' : 'unchecked');
      }
    }
    if (attrTrue(el, 'aria-selected')) flags.push('selected');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') flags.push('expanded');
    else if (expanded === 'false') flags.push('collapsed');
    else if (tag === 'SUMMARY' && el.parentElement && tagOf(el.parentElement) === 'DETAILS') {
      flags.push(el.parentElement.open ? 'expanded' : 'collapsed');
    }
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true' || pressed === 'mixed') flags.push('pressed');
    const current = el.getAttribute('aria-current');
    if (current && current !== 'false') flags.push('current');
    let disabled = attrTrue(el, 'aria-disabled');
    try {
      if (el.matches(':disabled')) disabled = true;
    } catch (e) {
      /* selector unsupported */
    }
    if (disabled) flags.push('disabled');
    if (el.required === true || attrTrue(el, 'aria-required')) flags.push('required');
    if (el.readOnly === true || attrTrue(el, 'aria-readonly')) flags.push('readonly');
    if (attrTrue(el, 'aria-invalid')) flags.push('invalid');
    if (el.multiple === true && tag === 'SELECT') flags.push('multiple');
    if (document.activeElement === el) flags.push('focused');
    return flags;
  }

  function valueOf(el, role) {
    const tag = tagOf(el);
    if (tag === 'SELECT') {
      const chosen = Array.from(el.selectedOptions).map((o) => collapse(o.label || o.textContent || ''));
      return chosen.join(', ');
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file') {
        return type === 'file' ? Array.from(el.files || []).map((f) => f.name).join(', ') : '';
      }
      return el.value || '';
    }
    if (role === 'textbox' && el.isContentEditable) return collapse(el.textContent || '');
    if (role === 'slider' || role === 'spinbutton' || role === 'progressbar' || role === 'meter') {
      const now = el.getAttribute('aria-valuenow');
      if (now !== null) return now;
      if ('value' in el) return String(el.value);
    }
    return '';
  }

  function hrefOf(el) {
    if (tagOf(el) !== 'A' && tagOf(el) !== 'AREA') return '';
    const raw = el.getAttribute('href') || '';
    if (raw.startsWith('javascript:')) return 'javascript:…';
    let abs;
    try {
      abs = new URL(raw, document.baseURI);
    } catch (e) {
      return clip(raw, 200);
    }
    if (abs.origin === location.origin) return clip(abs.pathname + abs.search + abs.hash, 200);
    return clip(abs.href, 200);
  }

  const isBlock = (display) => !display.startsWith('inline') && display !== 'contents';

  // --------------------------------------------------------------- the tree
  function buildTree(a) {
    const reg = registry();
    for (const [k, w] of reg.byRef) if (!w.deref()) reg.byRef.delete(k);
    let counter = a.startRef;
    const refFor = (el) => {
      let r = reg.byEl.get(el);
      if (!r) {
        counter += 1;
        r = `e${counter}`;
        reg.byEl.set(el, r);
        reg.byRef.set(r, new WeakRef(el));
      }
      return r;
    };

    const st = { count: 0, interactive: 0, visited: 0, truncated: false, limit: a.limit, actionsOnly: !!a.actionsOnly };

    const budgetLeft = () => {
      if (st.truncated) return false;
      const used = st.actionsOnly ? st.interactive : st.count;
      if (used >= st.limit) {
        st.truncated = true;
        return false;
      }
      return true;
    };

    function pushText(box, raw) {
      if (!raw) return;
      let item = box.items[box.items.length - 1];
      if (box.open && item && item.role === 'text') {
        item.raw += raw;
      } else {
        item = { role: 'text', raw, counted: false };
        box.items.push(item);
      }
      box.open = true;
      if (!item.counted && /\S/.test(item.raw)) {
        item.counted = true;
        st.count += 1;
      }
    }

    function pushNode(box, node) {
      box.items.push(node);
      box.open = false;
    }

    function finishText(items) {
      const out = [];
      for (const item of items) {
        if (item.role === 'text') {
          const t = clip(collapse(item.raw), 400);
          if (t) out.push({ role: 'text', text: t });
        } else {
          out.push(item);
        }
      }
      return out;
    }

    function walkChildren(el, box, vis) {
      for (const child of childrenOf(el)) {
        if (st.truncated) return;
        if (child.nodeType === 3) {
          if (vis) pushText(box, child.data);
        } else if (child.nodeType === 1) {
          visit(child, box);
        }
      }
    }

    function hasBox(el) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    const CLICKABLE_SKIP = new Set(['LABEL', 'HTML', 'BODY', 'SUMMARY']);
    function looksClickable(el, cs) {
      if (cs.cursor !== 'pointer' || CLICKABLE_SKIP.has(tagOf(el))) return false;
      const parent = el.parentElement;
      if (parent && getComputedStyle(parent).cursor === 'pointer') return false;
      if (el.querySelector('a[href], button, input, select, textarea, [role=button], [role=link], [role=tab]')) return false;
      return collapse(el.textContent || '').length > 0 && hasBox(el);
    }

    const CONSUMED_BY_PARENT = { LEGEND: 'FIELDSET', CAPTION: 'TABLE', FIGCAPTION: 'FIGURE' };

    // A <label> whose control is listed supplies that control's name, so its
    // text is not repeated as a separate line.
    function labelIsConsumed(el) {
      if (tagOf(el) !== 'LABEL' || !el.control) return false;
      const control = el.control;
      return roleOf(control) !== null && !isHiddenSubtree(control) && hasBox(control);
    }

    function visit(el, box) {
      st.visited += 1;
      if (st.visited > 60000) st.truncated = true;
      if (!budgetLeft()) return;
      if (isHiddenSubtree(el)) return;
      const parent = el.parentElement;
      if (parent && CONSUMED_BY_PARENT[tagOf(el)] === tagOf(parent)) return;
      if (labelIsConsumed(el)) {
        // The label text becomes the control's name. A control nested inside
        // the label still has to be listed.
        if (el.contains(el.control)) visit(el.control, box);
        return;
      }
      const cs = getComputedStyle(el);
      const vis = cs.visibility === 'visible';
      let role = roleOf(el);
      if (role === null && cs.display !== 'contents' && vis && looksClickable(el, cs)) role = 'clickable';

      if (role === null) {
        const block = isBlock(cs.display);
        if (block) box.open = false;
        if (tagOf(el) === 'BR') box.open = false;
        walkChildren(el, box, vis);
        if (block) box.open = false;
        return;
      }

      const interactive = INTERACTIVE.has(role);
      if (!vis) {
        if (!interactive) walkChildren(el, box, false);
        return;
      }
      if (interactive && !hasBox(el)) return;

      if (role === 'frame') {
        const fname = collapse(el.getAttribute('title') || el.getAttribute('name') || '');
        pushNode(box, { ref: refFor(el), role: 'frame', name: clip(fname, 160), flags: ['opaque'] });
        st.count += 1;
        return;
      }

      const node = { ref: refFor(el), role };
      let name = nameOf(el, role);
      // Unlabelled form controls: the name attribute is the best hint left.
      if (!name && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
        name = collapse(el.getAttribute('name') || '');
      }
      if (name) node.name = clip(name, 200);
      if (role === 'heading') node.level = Number(tagOf(el)[1]) || Number(el.getAttribute('aria-level')) || 2;
      const flags = flagsOf(el, role);
      if (flags.length) node.flags = flags;
      const href = hrefOf(el);
      if (href) node.href = href;

      const valueBearing = role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'listbox' || role === 'slider' || role === 'spinbutton' || role === 'progressbar' || role === 'meter';
      if (valueBearing) {
        const value = valueOf(el, role);
        if (value) {
          if (isSecretField(el)) node.redacted = true;
          else node.value = clip(value, 300);
        }
      }
      if (tagOf(el) === 'SELECT') {
        const opts = Array.from(el.options);
        node.options = opts.slice(0, 40).map((o) => clip(collapse(o.label || o.textContent || ''), 80));
        if (opts.length > 40) node.moreOptions = opts.length - 40;
      }

      if (interactive || (KEEP_WHEN_EMPTY.has(role) && !el.firstChild)) {
        st.count += 1;
        if (interactive) st.interactive += 1;
        pushNode(box, node);
        return;
      }

      // Structural node: gather children, then compact text-only nodes.
      st.count += 1;
      const inner = { items: [], open: false };
      walkChildren(el, inner, true);
      const children = finishText(inner.items);
      const onlyText = children.length > 0 && children.every((c) => c.role === 'text');
      if (onlyText) {
        if (!node.name) node.name = clip(children.map((c) => c.text).join(' '), 200);
        else node.children = children;
      } else if (children.length) {
        node.children = children;
      }
      if (!node.name && !node.children && !KEEP_WHEN_EMPTY.has(role)) {
        st.count -= 1;
        return;
      }
      pushNode(box, node);
    }

    const top = { items: [], open: false };
    const root = a.root || null;
    if (root) {
      visit(root, top);
    } else {
      const body = document.body || document.documentElement;
      visit(body, top);
    }
    return {
      tree: finishText(top.items),
      nextRef: counter,
      count: st.count,
      interactive: st.interactive,
      truncated: st.truncated,
      url: location.href,
      title: document.title || '',
    };
  }

  // ------------------------------------------------------------------- text
  function readText(root, max) {
    let text;
    if (!root) {
      text = (document.body && document.body.innerText) || '';
    } else if (tagOf(root) === 'INPUT' || tagOf(root) === 'TEXTAREA' || tagOf(root) === 'SELECT') {
      if (isSecretField(root)) {
        text = root.value ? '[redacted]' : '';
      } else if (tagOf(root) === 'SELECT') {
        text = Array.from(root.selectedOptions).map((o) => o.label || o.textContent || '').join(', ');
      } else {
        text = root.value || '';
      }
    } else {
      text = root.innerText !== undefined ? root.innerText : root.textContent || '';
    }
    const total = text.length;
    if (text.length > max) text = text.slice(0, max);
    return { text, total, truncated: total > max };
  }

  // ----------------------------------------------------------------- resolve
  function resolve(ref) {
    const el = registry().byRef.get(ref)?.deref();
    if (!el) return 'missing';
    if (!el.isConnected) return 'detached';
    return el;
  }

  if (op === 'tree') return buildTree(args);
  if (op === 'text') return readText(args.root || null, args.max);
  if (op === 'resolve') return resolve(args.ref);
  if (op === 'secret') return isSecretField(args.root);
  throw new Error(`unknown page op ${op}`);
}
