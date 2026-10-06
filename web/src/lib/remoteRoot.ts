/**
 * A repository on another machine, as this client names it (docs/FLEET.md,
 * phase 4): `@rooter:/home/u/proj`.
 *
 * Local roots are absolute paths and always begin with `/` (or a drive letter
 * on Windows), so the `@` can never be mistaken for one. That is the whole
 * trick: a panel that already passes `root` around keeps doing exactly that,
 * and the one place every request leaves through (api.ts) notices the prefix,
 * strips it, and sends the request to that machine through the hub's
 * `/fleet/proxy` instead of to this server. A file inside the repository is
 * `@rooter:/home/u/proj/a.ts` by the same rule, because panels build file
 * paths by joining onto the root.
 */
const RE = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,62}):(\/.*)$/;

export function remoteRoot(host: string, path: string): string {
  return `@${host}:${path}`;
}

export function splitRemote(value: string): { host: string; path: string } | null {
  const m = RE.exec(value);
  return m ? { host: m[1]!, path: m[2]! } : null;
}

export const isRemoteRoot = (value: string | null | undefined): boolean => !!value && RE.test(value);

/**
 * Where a request has to go, if any of it names a remote root — and the
 * request rewritten for that machine. Null when it is all local.
 *
 * Looks at the query string and at the top level of a JSON body (strings, and
 * arrays of strings, which is how every git route here passes paths). A request
 * that names two different machines is refused: there is no one place to send
 * it, and guessing would read one machine's repository with another's paths.
 */
export function remoteTarget(path: string, body?: unknown):
  | { host: string; path: string; body?: unknown; roots: string[] }
  | { error: string }
  | null {
  let host: string | null = null;
  let mixed = false;
  const roots: string[] = [];
  const take = (v: string, key?: string): string => {
    const r = splitRemote(v);
    if (!r) return v;
    if (host && host !== r.host) mixed = true;
    host ??= r.host;
    if (key === "root") roots.push(r.path);
    return r.path;
  };
  const u = new URL(path, "http://x");
  for (const [k, v] of [...u.searchParams]) {
    const next = take(v, k);
    if (next !== v) u.searchParams.set(k, next);
  }
  let outBody = body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      b[k] = typeof v === "string" ? take(v, k)
        : Array.isArray(v) ? v.map((x) => (typeof x === "string" ? take(x) : x))
        : v;
    }
    outBody = b;
  }
  if (mixed) return { error: "one request cannot name repositories on two machines" };
  if (!host) return null;
  return { host, path: u.pathname + u.search, roots, ...(body !== undefined ? { body: outBody } : {}) };
}

/**
 * The other machine's answer, with its paths named the way this client names
 * them: every string that is the repository root it was asked about, or sits
 * under it, gets the `@host:` prefix back.
 *
 * Panels trim the root off a file's path to show it, and build the next
 * request from paths an answer handed them. Both only work if the two agree
 * on the name — so a file at `/home/u/proj/a.ts` comes back as
 * `@rooter:/home/u/proj/a.ts`, matching the `@rooter:/home/u/proj` the panel
 * holds. Only strings that START with the root are touched; a diff line or a
 * commit message that merely mentions it is left alone.
 */
export function relabel<T>(value: T, host: string, roots: string[]): T {
  if (!roots.length) return value;
  const under = (s: string) => roots.some((r) => s === r || s.startsWith(r.endsWith("/") ? r : r + "/"));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return under(v) ? remoteRoot(host, v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}
