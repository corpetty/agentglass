// User settings that have to survive being launched from a desktop icon.
//
// A .env beside the server only works when the server is started from a
// checkout; the app has no such file and an arbitrary working directory. This
// reads the same settings from the XDG config dir, which both surfaces can
// find. Environment variables still win, so a one-off `AGENTGLASS_…=x bun run`
// overrides the file without editing it.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

export const CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "config.json"
);

/** A configured Claude account, as it lives on disk in config.json. The `id`
 *  is the same string that tags every event/session (see accountForPath). All
 *  fields but `id` are optional; a bare `{ id }` means "the default ~/.claude
 *  login, no desktop instance". */
export interface RawAccount {
  /** Stable identifier and event tag, e.g. "work" | "personal". */
  id: string;
  /** Display name; falls back to `id`. */
  label?: string;
  /** Plan bucket for scheduling hints, e.g. "pro" | "max5x" | "max20x". */
  plan_tier?: string;
  /** This account's CLI login dir (CLAUDE_CONFIG_DIR). Holds `.credentials.json`
   *  for the usage meter and `projects/` for the scanner. Absent = default
   *  ~/.claude. */
  claude_config_dir?: string;
  /** Working-directory prefixes that attribute to this account — merged into
   *  the top-level accountPaths fallback used by accountForPath(). */
  account_paths?: string[];
  /** Optional link to a desktop app instance name (Phase 3). */
  desktop_instance?: string;
}

interface Config {
  /** Work on this one project and nothing else. */
  root?: string;
  /** Directories to sweep for git repos, e.g. ["~/code", "/mnt/hdd/code"]. */
  repoDirs?: string[];
  /** Fallback account tagging for sessions with no explicit AGENTGLASS_ACCOUNT
   *  (e.g. backfilled transcript scans): a directory prefix → account label. */
  accountPaths?: { prefix: string; account: string }[];
  /** The account registry — source of truth for per-account meters, config
   *  dirs, and desktop instances. See accounts.ts. */
  accounts?: RawAccount[];
}

function load(): Config {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch (e) {
    // A typo shouldn't take the server down, but it must not pass unnoticed
    // either — the symptom would be settings mysteriously not applying.
    console.error(`[config] ignoring ${CONFIG_PATH}: ${e instanceof Error ? e.message : e}`);
    return {};
  }
}

const config = load();

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * Where to look for repos, most explicit source first.
 *
 * Returns an empty list when nothing is configured, which the caller reads as
 * "work it out from where the known projects live" — the out-of-the-box
 * behaviour. Naming the directories is both faster and more predictable, since
 * inference can only ever guess from history.
 */
/**
 * The single project this instance is for, if it was opened for one.
 *
 * Scoping to one directory is a different thing from listing several to search:
 * it means "this cockpit is about this project" — no sweeping, no other repos,
 * and the dashboard shows that project's work rather than everything on the
 * machine. Unset (the default) keeps the machine-wide behaviour.
 *
 * Only ever set on purpose: AGENTGLASS_ROOT, `root` in the config file, or the
 * directory passed to the app. Deliberately *not* inferred from the working
 * directory — that would silently scope a plain `bun run dev` in a checkout to
 * that checkout, which is a surprising way to lose the rest of your fleet.
 * Scoping is a decision, so it has to be stated.
 */
let cachedRoot: string | null | undefined;
export function workspaceRoot(): string | null {
  if (cachedRoot !== undefined) return cachedRoot;
  const asked = process.env.AGENTGLASS_ROOT || config.root;
  cachedRoot = asked ? resolveScope(asked) : null;
  return cachedRoot;
}

/** One rule for turning "what the user asked for" into a scope directory —
 *  shared by boot (env/config) and the runtime picker, so both resolve the
 *  same input to the same root. */
function resolveScope(asked: string): string {
  const abs = resolve(expand(asked));
  return repoTop(abs) ?? abs; // a path that isn't a repo is still a scope
}

/** git's own answer for "which repo is this", or null. */
function repoTop(dir: string): string | null {
  try {
    const p = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return null;
    return p.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Point this instance at one project (or back at the whole machine) while it
 * runs — the project picker in the UI calls this. The choice is applied
 * immediately (the transcript scanner re-evaluates scope on its next sweep,
 * every few seconds) and persisted to the config file so the next launch opens
 * the same project. Passing null clears the scope.
 *
 * Note the runtime cache is set directly: AGENTGLASS_ROOT from the environment
 * seeds the *initial* scope, but an explicit pick in the UI is newer intent and
 * wins for the rest of this process's life.
 */
export function setWorkspaceRoot(rootIn: string | null): { ok: boolean; workspace: string | null; persisted: boolean; error?: string; note?: string } {
  const fail = (error: string) => ({ ok: false as const, workspace: workspaceRoot(), persisted: false, error });
  let next: string | null = null;
  if (rootIn !== null) {
    if (typeof rootIn !== "string" || !rootIn.trim() || rootIn.includes("\0")) return fail("invalid path");
    const abs = resolve(expand(rootIn.trim()));
    try {
      if (!statSync(abs).isDirectory()) return fail("not a directory");
    } catch {
      return fail("directory does not exist");
    }
    next = resolveScope(abs);
  }
  cachedRoot = next;
  // Persist so the choice survives a restart. Re-read the file first — another
  // setting written there by hand must not be clobbered by a stale snapshot.
  let persisted = false;
  let note: string | undefined;
  try {
    let cur: Config = {};
    try {
      cur = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
    } catch (e) {
      // Absent → start fresh. Present but unreadable/malformed → do NOT write:
      // rewriting would silently destroy whatever else the user keeps in it
      // (repoDirs, future keys). The runtime switch still applies.
      if (existsSync(CONFIG_PATH)) {
        console.error(`[config] not persisting workspace — ${CONFIG_PATH} exists but can't be parsed: ${e instanceof Error ? e.message : e}`);
        return { ok: true, workspace: next, persisted: false, note: `config file is malformed — fix ${CONFIG_PATH} to persist this choice` };
      }
    }
    if (next) cur.root = next; else delete cur.root;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2) + "\n");
    persisted = true;
  } catch (e) {
    console.error(`[config] could not persist workspace to ${CONFIG_PATH}: ${e instanceof Error ? e.message : e}`);
  }
  // The env var is read before the config file at boot, so it will shadow this
  // choice on the next launch (e.g. the desktop app started with a directory).
  if (process.env.AGENTGLASS_ROOT) note = `AGENTGLASS_ROOT is set — it will override this choice on the next launch`;
  return { ok: true, workspace: next, persisted, note };
}

export function configuredRepoDirs(): string[] {
  const fromEnv = (process.env.AGENTGLASS_REPO_DIRS || "").split(":").filter(Boolean);
  const dirs = fromEnv.length ? fromEnv : config.repoDirs ?? [];
  return dirs.map(expand);
}

// Prefix → account fallback list, drawn from BOTH the flat `accountPaths` and
// each registry account's `account_paths`, longest-prefix-first so the most
// specific match wins. Boot snapshot: runtime account CRUD is picked up on the
// next launch (attribution prefixes rarely change mid-run; the live meters in
// accounts.ts read the registry directly).
const accountPaths = [
  ...(config.accountPaths ?? []).map((p) => ({ prefix: expand(p.prefix), account: p.account })),
  ...(config.accounts ?? []).flatMap((a) =>
    (a.account_paths ?? []).map((prefix) => ({ prefix: expand(prefix), account: a.id }))
  ),
].sort((a, b) => b.prefix.length - a.prefix.length);

/** Fallback account for a session with no explicit AGENTGLASS_ACCOUNT — the
 *  longest matching prefix from `accountPaths`/`accounts[].account_paths`, or
 *  null if nothing configured matches. Used by the transcript scanner (no hook
 *  env to read) and by normalize() when a live event arrived without one. */
export function accountForPath(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  for (const p of accountPaths) {
    if (cwd === p.prefix || cwd.startsWith(p.prefix + "/")) return p.account;
  }
  return null;
}

/** The account registry as written on disk (empty when unconfigured — the
 *  registry module synthesizes a default in that case). */
export function configuredAccounts(): RawAccount[] {
  return config.accounts ?? [];
}

/**
 * Safely read-modify-write config.json for a mutation that must not clobber
 * other hand-kept settings. Re-reads the file first; refuses to write over a
 * present-but-malformed file (that would silently destroy the user's other
 * keys). Also updates the in-memory snapshot so same-process reads stay fresh.
 */
export function patchConfig(mutate: (c: Config) => void): { ok: boolean; error?: string } {
  let cur: Config = {};
  try {
    cur = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch (e) {
    if (existsSync(CONFIG_PATH)) {
      return { ok: false, error: `config file is malformed — fix ${CONFIG_PATH} to persist changes` };
    }
  }
  try {
    mutate(cur);
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2) + "\n");
    config.accounts = cur.accounts; // keep the boot snapshot's registry current
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
