import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLoadedUrl,
  checkUrl,
  hostAllowed,
  normalizeInput,
  parseAllowList,
  sameAllowList,
} from '../src/policy.js';

function code(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return 'no-error';
}

describe('checkUrl: schemes', () => {
  it('accepts http and https and returns a normalised href', () => {
    assert.equal(checkUrl('https://Example.com'), 'https://example.com/');
    assert.equal(checkUrl('http://example.com/a?b=1#c'), 'http://example.com/a?b=1#c');
  });

  for (const bad of [
    'file:///etc/passwd',
    'data:text/html,<h1>x</h1>',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'chrome://settings',
    'chrome-extension://abc/page.html',
    'view-source:https://example.com',
    'about:blank',
    'blob:https://example.com/uuid',
    'ftp://example.com/file',
    'ws://example.com/socket',
  ]) {
    it(`blocks ${bad}`, () => {
      assert.equal(code(() => checkUrl(bad)), 'blocked_url');
    });
  }

  it('blocks schemes hidden behind tabs or newlines', () => {
    assert.equal(code(() => checkUrl('java\tscript:alert(1)')), 'blocked_url');
    assert.equal(code(() => checkUrl('java\nscript:alert(1)')), 'blocked_url');
    assert.equal(code(() => checkUrl('https://example.com/\u0000x')), 'blocked_url');
  });

  it('blocks embedded credentials', () => {
    assert.equal(code(() => checkUrl('https://user:pass@example.com/')), 'blocked_url');
    assert.equal(code(() => checkUrl('https://trusted.com@evil.test/')), 'blocked_url');
  });

  it('rejects empty and malformed input as usage errors', () => {
    assert.equal(code(() => checkUrl('')), 'usage');
    assert.equal(code(() => checkUrl('   ')), 'usage');
    assert.equal(code(() => checkUrl('http://')), 'usage');
  });
});

describe('metadata and link-local hosts', () => {
  for (const bad of [
    'http://169.254.169.254/latest/meta-data/',
    'http://2852039166/',
    'http://0xa9fea9fe/',
    'http://[::ffff:169.254.169.254]/',
    'http://[fe80::1]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
  ]) {
    it(`blocks ${bad}`, () => {
      assert.equal(code(() => checkUrl(bad)), 'blocked_url');
    });
  }

  it('allows them only when the allowlist names the exact host', () => {
    assert.equal(checkUrl('http://169.254.169.254/x', ['169.254.169.254']), 'http://169.254.169.254/x');
    assert.equal(code(() => checkUrl('http://169.254.169.254/x', ['example.com'])), 'blocked_url');
  });

  it('does not touch ordinary and loopback hosts', () => {
    assert.equal(checkUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000/');
    assert.equal(checkUrl('https://example.com/169.254.169.254'), 'https://example.com/169.254.169.254');
  });
});

describe('normalizeInput', () => {
  it('adds https to bare hosts and http to loopback hosts', () => {
    assert.equal(normalizeInput('example.com'), 'https://example.com');
    assert.equal(normalizeInput('example.com:8443/x'), 'https://example.com:8443/x');
    assert.equal(normalizeInput('localhost:3000'), 'http://localhost:3000');
    assert.equal(normalizeInput('127.0.0.1:8080/a'), 'http://127.0.0.1:8080/a');
  });

  it('leaves explicit schemes alone', () => {
    assert.equal(normalizeInput('http://a.test'), 'http://a.test');
    assert.equal(normalizeInput('javascript:alert(1)'), 'javascript:alert(1)');
  });
});

describe('allowlist', () => {
  it('parses repeated and comma separated entries, lower-cased and de-duplicated', () => {
    assert.deepEqual(parseAllowList(['Example.com, b.test', 'example.com']), ['b.test', 'example.com']);
    assert.equal(parseAllowList(undefined), null);
    assert.equal(parseAllowList(''), null);
    assert.equal(parseAllowList([' , ']), null);
  });

  it('rejects entries that are not bare hosts', () => {
    for (const bad of ['https://example.com', 'example.com/path', 'a.com:8080', 'user@a.com', 'a b.com', 'a.com#x']) {
      assert.equal(code(() => parseAllowList(bad)), 'usage', bad);
    }
  });

  it('matches the host and its subdomains', () => {
    const allow = parseAllowList('example.com');
    assert.equal(hostAllowed('example.com', allow), true);
    assert.equal(hostAllowed('www.example.com', allow), true);
    assert.equal(hostAllowed('EXAMPLE.COM.', allow), true);
    assert.equal(hostAllowed('notexample.com', allow), false);
    assert.equal(hostAllowed('example.com.evil.test', allow), false);
  });

  it('wildcard entries match subdomains only', () => {
    const allow = parseAllowList('*.example.com');
    assert.equal(hostAllowed('a.example.com', allow), true);
    assert.equal(hostAllowed('example.com', allow), false);
  });

  it('handles IPs and localhost', () => {
    const allow = parseAllowList('127.0.0.1,localhost,[::1]');
    assert.equal(hostAllowed('127.0.0.1', allow), true);
    assert.equal(hostAllowed('localhost', allow), true);
    assert.equal(hostAllowed('[::1]', allow), true);
    assert.equal(hostAllowed('127.0.0.2', allow), false);
  });

  it('allows everything when there is no list', () => {
    assert.equal(hostAllowed('anything.test', null), true);
  });

  it('refuses URLs outside the list with an actionable message', () => {
    const allow = parseAllowList('example.com');
    assert.equal(code(() => checkUrl('https://evil.test/', allow)), 'blocked_url');
    try {
      checkUrl('https://evil.test/', allow);
    } catch (err) {
      assert.match(err.message, /not in the allowed domains \(example\.com\)/);
    }
    assert.equal(checkUrl('https://docs.example.com/x', allow), 'https://docs.example.com/x');
  });

  it('is not fooled by userinfo or look-alike hosts', () => {
    const allow = parseAllowList('example.com');
    assert.equal(code(() => checkUrl('https://example.com@evil.test/', allow)), 'blocked_url');
    assert.equal(code(() => checkUrl('https://example.com.evil.test/', allow)), 'blocked_url');
    assert.equal(code(() => checkUrl('https://evil.test/?u=example.com', allow)), 'blocked_url');
  });

  it('compares lists regardless of order', () => {
    assert.equal(sameAllowList(parseAllowList('b.test,a.test'), parseAllowList('a.test,b.test')), true);
    assert.equal(sameAllowList(null, null), true);
    assert.equal(sameAllowList(null, ['a.test']), false);
  });
});

describe('checkLoadedUrl (redirects and popups)', () => {
  it('allows about:blank and permitted http(s) pages', () => {
    assert.equal(checkLoadedUrl('about:blank').ok, true);
    assert.equal(checkLoadedUrl('https://example.com/', ['example.com']).ok, true);
  });

  it('flags other schemes and hosts outside the list', () => {
    assert.equal(checkLoadedUrl('data:text/html,hi').ok, false);
    assert.equal(checkLoadedUrl('file:///etc/passwd').ok, false);
    const verdict = checkLoadedUrl('https://evil.test/', ['example.com']);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.error.code, 'blocked_url');
  });
});
