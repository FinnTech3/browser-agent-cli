// Error codes shared by the CLI and the daemon. Every failure the user can
// see carries one of these codes and maps to a stable process exit code.

export const EXIT = Object.freeze({
  ok: 0,
  internal: 1,
  usage: 2,
  ref: 3,
  element: 4,
  timeout: 5,
  blocked: 6,
  navigation: 7,
  session: 8,
});

const CODE_TO_EXIT = {
  usage: EXIT.usage,
  stale_ref: EXIT.ref,
  unknown_ref: EXIT.ref,
  not_found: EXIT.element,
  not_visible: EXIT.element,
  not_enabled: EXIT.element,
  obscured: EXIT.element,
  not_fillable: EXIT.element,
  option_not_found: EXIT.element,
  timeout: EXIT.timeout,
  blocked_url: EXIT.blocked,
  nav_failed: EXIT.navigation,
  no_history: EXIT.navigation,
  daemon_unavailable: EXIT.session,
  browser_lost: EXIT.session,
  policy_mismatch: EXIT.session,
  internal: EXIT.internal,
};

export const ERROR_CODES = Object.freeze(Object.keys(CODE_TO_EXIT));

export function exitCodeFor(code) {
  return CODE_TO_EXIT[code] ?? EXIT.internal;
}

export class BacError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BacError';
    this.code = code in CODE_TO_EXIT ? code : 'internal';
  }

  get exitCode() {
    return exitCodeFor(this.code);
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export function usageError(message) {
  return new BacError('usage', message);
}

// Turn anything thrown into a BacError without leaking stack traces.
export function toBacError(err) {
  if (err instanceof BacError) return err;
  const first = String(err?.message ?? err).split('\n')[0].trim();
  return new BacError('internal', `unexpected failure: ${first || 'unknown error'}`);
}
