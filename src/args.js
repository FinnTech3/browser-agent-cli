// Small argument parser: global options may appear anywhere, command options
// are defined per command, and "--" ends option parsing.

import { usageError } from './errors.js';
import { COMMANDS, GLOBAL_FLAGS } from './commands.js';

const NEGATIVE_NUMBER = /^-\d/;

function takeFlag(tokens, i, name, kind, bag, repeatable) {
  const token = tokens[i];
  const eq = token.indexOf('=');
  if (kind === 'bool') {
    if (eq !== -1) throw usageError(`--${name} does not take a value`);
    bag[name] = true;
    return i;
  }
  let value;
  let next = i;
  if (eq !== -1) {
    value = token.slice(eq + 1);
  } else {
    if (i + 1 >= tokens.length) throw usageError(`--${name} needs a value`);
    next = i + 1;
    value = tokens[next];
  }
  if (repeatable) {
    (bag[name] ??= []).push(value);
  } else {
    bag[name] = value;
  }
  return next;
}

// Returns { global, command, positionals, flags }.
export function parseArgv(argv) {
  const global = { 'allow-domain': [] };
  const rest = [];
  let literal = false;

  // Pass 1: peel global options out, wherever they are.
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (literal) {
      rest.push({ t: token, literal: true });
      continue;
    }
    if (token === '--') {
      literal = true;
      rest.push({ t: token, marker: true });
      continue;
    }
    if (token === '-h') {
      global.help = true;
      continue;
    }
    if (token === '-v') {
      global.version = true;
      continue;
    }
    if (token.startsWith('--')) {
      const name = token.slice(2).split('=')[0];
      if (Object.hasOwn(GLOBAL_FLAGS, name)) {
        i = takeFlag(argv, i, name, GLOBAL_FLAGS[name], global, name === 'allow-domain');
        continue;
      }
    }
    rest.push({ t: token });
  }

  const first = rest.find((r) => !r.marker);
  if (!first) return { global, command: null, positionals: [], flags: {} };
  const command = first.t;
  const spec = COMMANDS[command];
  if (!spec) {
    if (command.startsWith('-')) throw usageError(`unknown option ${command.slice(0, 30)}. Run: bac --help`);
    throw usageError(`unknown command "${command.slice(0, 30)}". Run: bac --help`);
  }

  // Pass 2: the command's own options and positionals.
  const tokens = rest.filter((r) => r !== first);
  const positionals = [];
  const flags = {};
  let afterMarker = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const { t, literal: lit, marker } = tokens[i];
    if (marker && !afterMarker) {
      afterMarker = true;
      continue;
    }
    if (lit || afterMarker || !t.startsWith('-') || t === '-' || NEGATIVE_NUMBER.test(t)) {
      positionals.push(t);
      continue;
    }
    if (!t.startsWith('--')) throw usageError(`unknown option ${t.slice(0, 30)} for "${command}"`);
    const name = t.slice(2).split('=')[0];
    const kind = spec.flags[name];
    if (!kind) throw usageError(`unknown option --${name.slice(0, 30)} for "${command}". Run: bac ${command} --help`);
    // takeFlag reads from a plain string array
    const plain = tokens.map((x) => x.t);
    i = takeFlag(plain, i, name, kind, flags, false);
  }

  if (global.help || global.version) return { global, command, positionals, flags };
  if (positionals.length < spec.min) {
    throw usageError(`"${command}" needs more arguments. Usage: bac ${spec.usage.split('   |   ')[0]}`);
  }
  if (positionals.length > spec.max) {
    throw usageError(`"${command}" got too many arguments. Usage: bac ${spec.usage.split('   |   ')[0]}`);
  }
  return { global, command, positionals, flags };
}
