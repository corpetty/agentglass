// Cowork / Claude Desktop ingestion.
//
// agentglass discovers work from Claude Code CLI transcripts under
// ~/.claude/projects. Claude Desktop / Cowork writes nowhere near there — its
// data lives under the Desktop app's config dir (~/.config/Claude on Linux,
// ~/Library/Application Support/Claude on macOS). Two stores there are worth
// ingesting:
//
//   local-agent-mode-sessions/<acct>/<device>/local_<id>/audit.jsonl
//     Full message streams for local-agent sessions — near-identical schema to
//     a CLI transcript, so they flow through the same ingest with a thin shim
//     (normalizeAuditLine). Their cwd is a sandbox (an uploaded-file output
//     dir, a VM mount, or bare $HOME), never a repo, so they are bucketed under
//     one synthetic "Cowork" project rather than projected by cwd.
//
//   claude-code-sessions/<acct>/<device>/local_<id>.json
//     A session *catalog*: title, model, timestamps, and a `cliSessionId` that
//     ties the entry to a real CLI transcript this machine may already have
//     scanned. Not a message stream — parsed as metadata only (parseIndexEntry),
//     which attaches human titles to sessions that would otherwise show a bare
//     uuid, and lists remote sessions whose transcript never reached this
//     machine.
//
// The conversations behind ~/Claude/Projects/* (Cowork's user-files root) run
// remotely / in the VM and are NOT on this machine in readable form — only the
// two host stores above are. This module stays pure: it locates the stores,
// normalizes an audit line, and parses an index entry. Project resolution,
// scope, the projectPaths map and every DB write stay in transcripts.ts, so
// there is no import cycle. Kill switch: AGENTGLASS_COWORK_DISABLED=1.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The ingest shape of a scan root. `claude-code` is the historical default
 *  (a tree of CLI *.jsonl transcripts); the two `cowork-*` formats are the
 *  Desktop stores above. */
export type SourceFormat = "claude-code" | "cowork-audit" | "cowork-index";

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** The account tag every Cowork event and session carries, so the cockpit can
 *  tell Desktop/Cowork activity apart from CLI work. Deliberately its own tag,
 *  not the default "work": Cowork bills the Desktop login, which the account
 *  registry doesn't meter. */
export const COWORK_ACCOUNT = "cowork";

/** The Desktop app's config dir. `AGENTGLASS_COWORK_DIR` overrides; otherwise the
 *  first platform default that exists, falling back to the Linux path so
 *  coworkScanRoots() can still return roots that simply don't resolve yet. */
export function coworkHome(): string {
  const override = process.env.AGENTGLASS_COWORK_DIR;
  if (override) return expand(override);
  const candidates = [
    join(homedir(), ".config", "Claude"), // Linux
    join(homedir(), "Library", "Application Support", "Claude"), // macOS
  ];
  return candidates.find((d) => existsSync(d)) ?? candidates[0]!;
}

/** On unless AGENTGLASS_COWORK_DISABLED=1 and the Desktop config dir exists.
 *  Auto-on when present, so the feature needs no configuration on a machine
 *  that actually runs Claude Desktop, and is inert on one that doesn't. */
export function coworkEnabled(): boolean {
  if (process.env.AGENTGLASS_COWORK_DISABLED === "1") return false;
  return existsSync(coworkHome());
}

/** The synthetic project every audit session is bucketed under. Its path is
 *  Cowork's user-files root (`coworkUserFilesPath` from the Desktop config,
 *  e.g. ~/Claude) so it is a real directory that scope and git can reason
 *  about; its label is "Cowork". Audit cwds are sandboxes, never repos, so
 *  projecting by cwd would scatter one-off tasks across junk folders named
 *  "outputs" / "petty" — one honest bucket is what a human means by "my Cowork
 *  work". */
export function coworkAuditProject(): { source_app: string; project_path: string } {
  return { source_app: "Cowork", project_path: coworkUserFilesRoot() };
}

/** `coworkUserFilesPath` from claude_desktop_config.json, else ~/Claude. */
export function coworkUserFilesRoot(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(coworkHome(), "claude_desktop_config.json"), "utf8")) as {
      coworkUserFilesPath?: unknown;
    };
    if (typeof cfg.coworkUserFilesPath === "string" && cfg.coworkUserFilesPath) return cfg.coworkUserFilesPath;
  } catch {
    /* no config / unreadable — fall through to the default */
  }
  return join(homedir(), "Claude");
}

/** The Cowork scan roots, each tagged with its ingest format. Empty when
 *  disabled, so the scanner appends nothing. */
export function coworkScanRoots(): { dir: string; account: string; format: SourceFormat }[] {
  if (!coworkEnabled()) return [];
  const home = coworkHome();
  return [
    { dir: join(home, "local-agent-mode-sessions"), account: COWORK_ACCOUNT, format: "cowork-audit" },
    { dir: join(home, "claude-code-sessions"), account: COWORK_ACCOUNT, format: "cowork-index" },
  ];
}

/** Which filenames each format ingests. */
export function matcherFor(format: SourceFormat): (name: string) => boolean {
  if (format === "cowork-audit") return (n) => n === "audit.jsonl";
  if (format === "cowork-index") return (n) => n.startsWith("local_") && n.endsWith(".json");
  return (n) => n.endsWith(".jsonl");
}

/** Map one audit.jsonl line onto the CLI transcript shape lineToBodies expects.
 *  The only structural difference is the timestamp field name — everything else
 *  (`type`, `message.role/content`, tool_use blocks, `usage`) is already
 *  identical, and audit's extra line types (system/result/rate_limit_event/
 *  tool_use_summary) are simply ignored downstream. Mutates the freshly-parsed
 *  object in place. */
export function normalizeAuditLine(o: Record<string, unknown>): Record<string, unknown> {
  if (o.timestamp == null && o._audit_timestamp != null) o.timestamp = o._audit_timestamp;
  return o;
}

/** A parsed session-index entry, reduced to what the metadata upsert needs. */
export interface CoworkIndexEntry {
  /** The session to attach to: the linked CLI transcript's id when present (so
   *  the entry *enriches* an already-scanned session), else the index's own id
   *  (a remote/VM session with no local transcript). */
  session_id: string;
  /** The real working directory — a repo, unlike the audit sandboxes. */
  cwd: string;
  model: string | null;
  title: string | null;
  /** True when the user named the session by hand (→ custom_title); false for
   *  an auto-generated one (→ ai_title). */
  titleIsCustom: boolean;
  started_at: number;
  last_seen: number;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

/** Parse a `local_*.json` session-index file. Returns null when the JSON is
 *  unusable or carries no working directory (nothing to project it onto). */
export function parseIndexEntry(raw: string): CoworkIndexEntry | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cwd = s(o.cwd) ?? s(o.originCwd);
  const session_id = s(o.cliSessionId) ?? s(o.sessionId);
  if (!cwd || !session_id) return null;
  const created = num(o.createdAt);
  const last = num(o.lastActivityAt) ?? num(o.lastFocusedAt) ?? created;
  return {
    session_id,
    cwd,
    model: s(o.model),
    title: s(o.title),
    // titleSource "auto" is the generated title; anything else (a manual
    // rename) is the user's own and must not be overwritten by a later auto one.
    titleIsCustom: s(o.titleSource) != null && o.titleSource !== "auto",
    started_at: created ?? last ?? 0,
    last_seen: last ?? created ?? 0,
  };
}
