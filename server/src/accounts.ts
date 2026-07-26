// The account registry — source of truth for multi-account operation.
//
// An "account" is one Claude subscription/login. Its `id` is the same string
// that tags every event and session (see config.accountForPath). The registry
// adds what the tag alone can't carry: which CLI login dir the account uses
// (for its usage meter and transcripts), its plan tier, and an optional link to
// a desktop instance.
//
// Backed by the `accounts` array in ~/.config/agentglass/config.json. When
// nothing is configured we synthesize a single default account pointing at
// ~/.claude, so single-account setups keep working with zero configuration.

import { homedir } from "node:os";
import { join } from "node:path";
import { configuredAccounts, patchConfig, type RawAccount } from "./config.ts";

/** The tag used for sessions with no explicit account — matches the default in
 *  ingest.normalize(). */
export const DEFAULT_ACCOUNT_ID = "work";

/** A fully-resolved account: absolute paths, defaults filled in. */
export interface Account {
  id: string;
  label: string;
  planTier: string | null;
  /** Absolute CLAUDE_CONFIG_DIR; ~/.claude for the default login. */
  configDir: string;
  /** Where this account's OAuth credentials live (for the usage meter). */
  credentialsPath: string;
  /** Where this account's transcripts live (for the scanner). */
  projectsDir: string;
  /** Working-directory prefixes attributed to this account. */
  accountPaths: string[];
  desktopInstance: string | null;
  /** True when this account uses the default ~/.claude login (no explicit
   *  claude_config_dir), including the synthesized default. */
  usesDefaultDir: boolean;
  /** True when this account was synthesized because none were configured. */
  synthesized: boolean;
}

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const DEFAULT_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
  ? expand(process.env.CLAUDE_CONFIG_DIR)
  : join(homedir(), ".claude");

function resolve(raw: RawAccount, synthesized = false): Account {
  const usesDefaultDir = !raw.claude_config_dir;
  const configDir = usesDefaultDir ? DEFAULT_CONFIG_DIR : expand(raw.claude_config_dir!);
  // The default login honors CLAUDE_CREDENTIALS so the meter keeps reading the
  // exact file it did before the registry existed; explicit accounts always
  // read <configDir>/.credentials.json.
  const credentialsPath =
    usesDefaultDir && process.env.CLAUDE_CREDENTIALS
      ? process.env.CLAUDE_CREDENTIALS
      : join(configDir, ".credentials.json");
  return {
    id: raw.id,
    label: raw.label?.trim() || raw.id,
    planTier: raw.plan_tier ?? null,
    configDir,
    credentialsPath,
    projectsDir: join(configDir, "projects"),
    accountPaths: (raw.account_paths ?? []).map(expand),
    desktopInstance: raw.desktop_instance ?? null,
    usesDefaultDir,
    synthesized,
  };
}

/** Every account, resolved. Synthesizes a single default when none configured. */
export function listAccounts(): Account[] {
  const raw = configuredAccounts();
  if (!raw.length) return [resolve({ id: DEFAULT_ACCOUNT_ID }, true)];
  return raw.map((a) => resolve(a));
}

export function accountById(id: string): Account | null {
  return listAccounts().find((a) => a.id === id) ?? null;
}

/** The account a bare `/usage` request (no ?account=) resolves to: the one on
 *  the default ~/.claude login, else the first configured. */
export function defaultAccount(): Account {
  const all = listAccounts();
  return all.find((a) => a.usesDefaultDir) ?? all[0];
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Create or update an account by id. Only the fields present in `patch` are
 *  changed on an existing account. */
export function upsertAccount(patch: RawAccount): { ok: boolean; error?: string; account?: Account } {
  const id = (patch.id ?? "").trim();
  if (!ID_RE.test(id)) return { ok: false, error: "id must be 1–64 chars of A–Z a–z 0–9 _ -" };
  const clean: RawAccount = { ...patch, id };
  const res = patchConfig((c) => {
    const list = c.accounts ?? (c.accounts = []);
    const i = list.findIndex((a) => a.id === id);
    if (i >= 0) list[i] = { ...list[i], ...clean };
    else list.push(clean);
  });
  if (!res.ok) return res;
  return { ok: true, account: accountById(id) ?? undefined };
}

/** Remove an account from the registry. Its historical events/sessions keep
 *  their tag; only the live registry entry (meter, config dir) goes away. */
export function removeAccount(id: string): { ok: boolean; error?: string } {
  return patchConfig((c) => {
    c.accounts = (c.accounts ?? []).filter((a) => a.id !== id);
  });
}
