// Command-line front end: parse, validate, talk to the daemon, print.

import { parseArgv } from './args.js';
import { send, stopSession } from './client.js';
import { COMMANDS, commandHelp, helpText, parseTimeout } from './commands.js';
import { BacError, EXIT, toBacError, usageError } from './errors.js';
import { formatErrorJson, formatJson, formatPlain } from './format.js';
import { validateSessionName, writeShot } from './paths.js';
import { checkUrl, parseAllowList } from './policy.js';
import { VERSION } from './version.js';

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(usageError('--stdin needs piped input, for example: printf %s "$VALUE" | bac put e2 --stdin'));
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) reject(usageError('standard input is too large'));
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// Runs one CLI invocation and returns the exit code. All output goes through
// `io` so tests can capture it.
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const cwd = io.cwd ?? process.cwd();
  let command = null;
  let json = false;

  try {
    if (process.platform === 'win32' && !io.stdout) {
      throw new BacError('daemon_unavailable', 'bac supports Linux and macOS only (the daemon uses a unix socket). Use WSL on Windows');
    }
    const parsed = parseArgv(argv);
    json = !!parsed.global.json;
    command = parsed.command;

    if (parsed.global.version) {
      out(`bac ${VERSION}`);
      return EXIT.ok;
    }
    if (parsed.global.help || !command) {
      out(command ? commandHelp(command) : helpText());
      return parsed.global.help ? EXIT.ok : EXIT.usage;
    }

    const spec = COMMANDS[command];
    const session = validateSessionName(parsed.global.session ?? env.BAC_SESSION ?? 'default');
    const timeoutMs = parseTimeout(parsed.global.timeout, env);
    const allowInput = parsed.global['allow-domain'].length ? parsed.global['allow-domain'] : env.BAC_ALLOW_DOMAINS;
    const allow = parseAllowList(allowInput ?? null);

    const built = await spec.build(parsed.positionals, parsed.flags, { cwd, readStdin: io.readStdin ?? readStdin, now: io.now });
    const params = built.params;
    const ctx = { params, shotPath: built.local?.target.path };

    // Cheap checks first: refuse bad URLs before a browser is even started.
    if (command === 'go') params.url = checkUrl(params.url, allow);
    if (command === 'tabs' && params.action === 'new' && params.url) params.url = checkUrl(params.url, allow);

    let data;
    if (command === 'stop') {
      data = await stopSession({ env, session });
    } else if (command === 'status') {
      data = (await send({ env, session, cmd: 'status', timeoutMs, start: false })) ?? { running: false };
    } else {
      data = await send({ env, session, allow, cmd: command, params, timeoutMs });
    }

    if (command === 'shot') {
      ctx.shotPath = writeShot(built.local.target, Buffer.from(data.base64, 'base64'));
    }
    out(json ? formatJson(command, data, ctx) : formatPlain(command, data, ctx));
    return EXIT.ok;
  } catch (e) {
    const error = e instanceof BacError ? e : toBacError(e);
    if (json) out(formatErrorJson(command, error));
    else err(`error[${error.code}]: ${error.message}`);
    return error.exitCode;
  }
}
