/**
 * Pure startup-validation rules for `rly serve`.
 *
 * Kept separate from the `rly serve` CLI wiring in `src/index.ts` so tests can
 * exercise the decision table (what combinations refuse to start, what
 * combinations warn) without shelling out a CLI subprocess.
 *
 * The CLI handler is responsible for actually printing to stderr and calling
 * `process.exit` — this module only decides.
 */

export interface ServeOptions {
  /** Host the server will bind to (post-default-resolution). */
  host: string;
  /** Bearer token, or `undefined` if no auth. */
  token: string | undefined;
  /** Whether the user passed `--allow-unauthenticated-remote`. */
  allowUnauthenticatedRemote: boolean;
}

export type ServeValidation =
  | { kind: "ok"; warnings: string[] }
  | { kind: "error"; message: string };

/**
 * Hosts we treat as loopback-only. `localhost` is included even though it can
 * in theory resolve elsewhere via `/etc/hosts` — in practice every mainstream
 * setup points it at 127.0.0.1/::1, and users who deliberately re-point it
 * into the wide world are already in "you're on your own" territory.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost"
]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Decide whether `rly serve` can start with the given options.
 *
 * Rules:
 *  - Non-loopback host + no token + no `--allow-unauthenticated-remote`
 *    -> HARD STOP. A bare WAN-listening MCP dispatch surface is the one
 *    configuration that is always unsafe; no warning is sufficient.
 *  - Non-loopback host + no token + `--allow-unauthenticated-remote`
 *    -> OK with a loud warning. User explicitly opted in.
 *  - Loopback host + no token
 *    -> OK with a quieter warning. Default dev setup; matches how `rly` is
 *    pitched in `rly welcome` and the README.
 *  - Any host + token
 *    -> OK. Auth is the supported way to open the dispatch surface.
 */
export function validateServeOptions(opts: ServeOptions): ServeValidation {
  const loopback = isLoopbackHost(opts.host);

  if (!loopback && !opts.token && !opts.allowUnauthenticatedRemote) {
    return {
      kind: "error",
      message:
        `[rly serve] Refusing to start: --host ${opts.host} is non-loopback and no --token was provided.\n` +
        "           Either pass --token <token> (recommended) or --allow-unauthenticated-remote to override."
    };
  }

  const warnings: string[] = [];

  if (!opts.token) {
    warnings.push(
      "[rly serve] WARNING: no auth token — anyone who can reach this host:port can use the MCP server."
    );
    warnings.push(
      "           Set RELAY_TOKEN or pass --token <token> to require a Bearer token."
    );
  }

  if (!loopback && !opts.token && opts.allowUnauthenticatedRemote) {
    warnings.push(
      `[rly serve] WARNING: listening on non-loopback host "${opts.host}" without auth (--allow-unauthenticated-remote). This is dangerous.`
    );
  }

  return { kind: "ok", warnings };
}
