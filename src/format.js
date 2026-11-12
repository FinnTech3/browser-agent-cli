// Plain-text and JSON output for each command. Lines outside a boundary block
// never contain text copied from a web page; URLs are shortened with safeUrl.

import {
  cleanText,
  frame,
  makeBoundaryId,
  renderLook,
  renderNotes,
  renderTabs,
  renderText,
  safeUrl,
} from './render.js';

function seconds(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatPlain(cmd, data, ctx = {}) {
  const lines = [];
  const params = ctx.params ?? {};
  switch (cmd) {
    case 'go':
      lines.push(`ok went to ${safeUrl(data.url)}${data.status ? ` (HTTP ${data.status})` : ''}`);
      break;
    case 'back':
      lines.push(`ok went back to ${safeUrl(data.url)}`);
      break;
    case 'look':
      lines.push(renderLook(data, ctx.boundary ?? makeBoundaryId(), { actionsOnly: params.actionsOnly }));
      break;
    case 'tap':
      lines.push(`ok tapped ${params.ref}${data.navigated ? `, now at ${safeUrl(data.url)}` : ''}`);
      break;
    case 'put':
      lines.push(
        `ok filled ${params.ref} with ${data.chars} character${data.chars === 1 ? '' : 's'}` +
          (data.secretField ? ' (looks like a secret field; never shown in output)' : ''),
      );
      break;
    case 'key':
      lines.push(`ok pressed ${cleanText(params.key, 40)}${data.navigated ? `, now at ${safeUrl(data.url)}` : ''}`);
      break;
    case 'pick':
      lines.push(`ok picked ${data.picked} option${data.picked === 1 ? '' : 's'} in ${params.ref}`);
      break;
    case 'scroll': {
      const where = data.atBottom ? ', at the bottom' : data.atTop ? ', at the top' : '';
      lines.push(`ok scrolled to y=${data.y} of ${data.max}${where}`);
      break;
    }
    case 'text':
      lines.push(renderText(data, ctx.boundary ?? makeBoundaryId()));
      break;
    case 'until':
      lines.push(`ok ${untilPhrase(params)} after ${data.waitedMs}ms`);
      break;
    case 'shot':
      lines.push(`ok saved ${ctx.shotPath} (${data.bytes} bytes)`);
      break;
    case 'tabs':
      lines.push(...formatTabs(data, params, ctx));
      break;
    case 'status':
      lines.push(...formatStatus(data));
      break;
    case 'stop':
      lines.push(data.wasRunning ? `ok stopped${data.forced ? ' (had to terminate the daemon)' : ''}` : 'ok not running');
      break;
    default:
      lines.push('ok');
  }
  lines.push(...renderNotes(data.notes));
  return lines.join('\n');
}

function untilPhrase(p) {
  const v = cleanText(p.value ?? '', 60);
  switch (p.kind) {
    case 'text': return `text "${v}" appeared`;
    case 'gone': return `text "${v}" disappeared`;
    case 'css': return p.hidden ? `"${v}" is hidden` : `"${v}" is visible`;
    case 'url': return `url contains "${v}"`;
    default: return 'network is idle';
  }
}

function formatTabs(data, params, ctx) {
  switch (params.action) {
    case 'use': return [`ok switched to tab ${data.active} (${safeUrl(data.url)})`];
    case 'new': return [`ok opened tab ${data.active} (${safeUrl(data.url)})`];
    case 'close': return [`ok closed tab ${data.closed}; ${data.tabs} open, active is ${data.active}`];
    default: return [renderTabs(data, ctx.boundary ?? makeBoundaryId())];
  }
}

function formatStatus(data) {
  if (!data.running) return ['not running'];
  return [
    `running  pid ${data.pid}, session "${data.session}", up ${seconds(data.uptimeMs)}`,
    `browser  ${data.browser}`,
    `tabs     ${data.tabs} open, active is ${data.activeTab}`,
    `domains  ${data.allow ? data.allow.join(', ') : 'any (no allowlist)'}`,
    `idle     stops after ${data.idleSeconds}s without commands`,
    `socket   ${data.socket}`,
  ];
}

// JSON form: the daemon data plus the command name. Large payloads that are
// written to disk are replaced by their location.
export function formatJson(cmd, data, ctx = {}) {
  const out = { ok: true, command: cmd, ...data };
  if (cmd === 'shot') {
    delete out.base64;
    out.path = ctx.shotPath;
  }
  if (cmd === 'put') delete out.text;
  return JSON.stringify(out);
}

export function formatErrorJson(cmd, error) {
  return JSON.stringify({ ok: false, command: cmd, error: { code: error.code, message: error.message } });
}

export { frame };
