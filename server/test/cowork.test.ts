// Cowork / Claude Desktop ingestion. Two disjoint host stores feed the cockpit
// (see cowork.ts): local-agent-mode audit transcripts (real messages, bucketed
// under one synthetic "Cowork" project) and the session index (title/model
// metadata projected onto real repos). These tests pin the shape of each, the
// first-prompt titling that names an otherwise-anonymous audit session, and the
// kill switch.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-cowork-"));
const COWORK = join(dir, "config-claude");
const USERFILES = join(COWORK, "userfiles");
// Isolate: sweep the fixture Cowork store and an empty CLI projects dir, never
// the real machine. Set before importing anything that reads them.
process.env.AGENTGLASS_COWORK_DIR = COWORK;
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "empty-projects");
process.env.AGENTGLASS_DB ||= join(dir, "cowork.db");
mkdirSync(process.env.AGENTGLASS_PROJECTS_DIR, { recursive: true });
mkdirSync(COWORK, { recursive: true });
// coworkUserFilesPath decides the "Cowork" bucket's path; pin it for the test.
writeFileSync(join(COWORK, "claude_desktop_config.json"), JSON.stringify({ coworkUserFilesPath: USERFILES }));

const ACCT = "acct-1";
const DEV = "dev-1";
const auditDir = join(COWORK, "local-agent-mode-sessions", ACCT, DEV);
const indexDir = join(COWORK, "claude-code-sessions", ACCT, DEV);
mkdirSync(auditDir, { recursive: true });
mkdirSync(indexDir, { recursive: true });

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let cowork: typeof import("../src/cowork.ts");
// A cwd inside the workspace scope (or the fixture when unscoped), so the sweep's
// in-scope test doesn't drop the fixture sessions when the suite runs scoped.
let baseCwd = dir;

const iso = () => new Date().toISOString();
const recentMs = () => Date.now() - 60_000;

// One audit session directory: local_<id>/audit.jsonl. session_id is the dir
// name (audit lines carry no `sessionId` the sniffer recognizes).
function writeAudit(id: string, cwd: string, firstPrompt: string): void {
  const d = join(auditDir, id);
  mkdirSync(d, { recursive: true });
  const lines = [
    { type: "system", subtype: "init", cwd, session_id: id, model: "claude-fable-5", _audit_timestamp: iso() },
    { type: "user", session_id: id, message: { role: "user", content: firstPrompt }, _audit_timestamp: iso() },
    {
      type: "assistant", session_id: id,
      message: { model: "claude-fable-5", id: "m1", role: "assistant", content: [{ type: "text", text: "On it." }], usage: { input_tokens: 7, output_tokens: 3 } },
      _audit_timestamp: iso(),
    },
    // An audit-only line type the CLI schema never has — must be ignored, not crash.
    { type: "rate_limit_event", session_id: id, _audit_timestamp: iso() },
  ];
  writeFileSync(join(d, "audit.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function writeIndex(file: string, entry: Record<string, unknown>): void {
  writeFileSync(join(indexDir, `${file}.json`), JSON.stringify(entry));
}

const session = (sid: string) =>
  db.db.query<Record<string, unknown>, [string]>("SELECT * FROM sessions WHERE session_id = ?").get(sid);
const promptsOf = (sid: string) =>
  db.db
    .query<{ payload: string }, [string]>("SELECT payload FROM events WHERE session_id = ? AND hook_event_type = 'UserPromptSubmit' ORDER BY id")
    .all(sid)
    .map((r) => JSON.parse(r.payload).prompt as string);

const AUDIT_ID = "local_aud00000-0000-4000-8000-000000000001";
const CLI_SID = "cli00000-0000-4000-8000-0000000000aa";

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  cowork = await import("../src/cowork.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) baseCwd = scope;
});

afterAll(() => {
  if (!db) return;
  const ids = [AUDIT_ID, CLI_SID, "local_disabled-0000-4000-8000-000000000009"];
  const marks = ids.map(() => "?").join(",");
  for (const t of ["events", "sessions", "transcript_files"]) {
    try { db.db.run(`DELETE FROM ${t} WHERE session_id IN (${marks})`, ids); } catch { /* column may not exist */ }
  }
});

describe("cowork audit transcripts (real messages)", () => {
  test("an audit session ingests messages under the Cowork bucket, titled from its first prompt", async () => {
    writeAudit(AUDIT_ID, join(baseCwd, "sandbox", "outputs"), "Draft a technical blog post about widgets");
    await scan.scanOnce(null);

    const s = session(AUDIT_ID);
    expect(s).toBeTruthy();
    // Bucketed, not projected by its sandbox cwd.
    expect(s!.source_app).toBe("Cowork");
    expect(s!.project_path).toBe(USERFILES);
    expect(s!.account).toBe("cowork");
    // The user + assistant lines became events; the rate_limit_event did not.
    expect(promptsOf(AUDIT_ID)).toEqual(["Draft a technical blog post about widgets"]);
    expect(Number(s!.event_count)).toBeGreaterThanOrEqual(2);
    // No title line in an audit transcript → named from the first prompt.
    expect(s!.ai_title).toBe("Draft a technical blog post about widgets");
    // The `_audit_timestamp` shim landed: the event isn't stamped at epoch.
    expect(Number(s!.started_at)).toBeGreaterThan(0);
  });
});

describe("cowork session index (metadata catalog)", () => {
  test("an index entry creates a titled, metadata-only session on its real repo", async () => {
    const cwd = join(baseCwd, "repo-widget");
    writeIndex("local_idx1", {
      sessionId: "local_idx0000",
      cliSessionId: CLI_SID, // the session it enriches / stands in for
      cwd,
      model: "claude-opus-5",
      title: "Build the widget factory",
      titleSource: "auto",
      createdAt: recentMs(),
      lastActivityAt: recentMs(),
    });
    await scan.scanOnce(null);

    // Attached to the CLI session id, not the index's own id.
    const s = session(CLI_SID);
    expect(s).toBeTruthy();
    expect(s!.source_app).toBe("repo-widget");
    expect(s!.project_path).toBe(cwd);
    expect(s!.model_name).toBe("claude-opus-5");
    // titleSource "auto" → ai_title, never custom_title.
    expect(s!.ai_title).toBe("Build the widget factory");
    expect(s!.custom_title).toBeNull();
    // Metadata only: no message stream.
    expect(Number(s!.event_count)).toBe(0);
  });
});

describe("kill switch", () => {
  test("AGENTGLASS_COWORK_DISABLED=1 stops all Cowork ingestion", async () => {
    const prior = process.env.AGENTGLASS_COWORK_DISABLED;
    process.env.AGENTGLASS_COWORK_DISABLED = "1";
    try {
      expect(cowork.coworkEnabled()).toBe(false);
      expect(cowork.coworkScanRoots()).toEqual([]);
      const disabledId = "local_disabled-0000-4000-8000-000000000009";
      writeAudit(disabledId, join(baseCwd, "sandbox"), "should not be ingested");
      await scan.scanOnce(null);
      expect(session(disabledId)).toBeFalsy();
    } finally {
      process.env.AGENTGLASS_COWORK_DISABLED = prior;
    }
  });
});

describe("pure parsers", () => {
  test("normalizeAuditLine maps _audit_timestamp onto timestamp, leaving an existing one", () => {
    expect(cowork.normalizeAuditLine({ _audit_timestamp: "2026-01-01T00:00:00Z" }).timestamp).toBe("2026-01-01T00:00:00Z");
    expect(cowork.normalizeAuditLine({ timestamp: "keep", _audit_timestamp: "other" }).timestamp).toBe("keep");
  });

  test("parseIndexEntry prefers cliSessionId and reads titleSource", () => {
    const e = cowork.parseIndexEntry(JSON.stringify({
      sessionId: "local_x", cliSessionId: "cli-y", cwd: "/repo", model: "m",
      title: "T", titleSource: "user", createdAt: 100, lastActivityAt: 200,
    }))!;
    expect(e.session_id).toBe("cli-y");
    expect(e.cwd).toBe("/repo");
    expect(e.titleIsCustom).toBe(true); // a manual rename
    expect(e.started_at).toBe(100);
    expect(e.last_seen).toBe(200);
  });

  test("parseIndexEntry falls back to sessionId, treats auto titles as non-custom", () => {
    const e = cowork.parseIndexEntry(JSON.stringify({ sessionId: "local_z", cwd: "/r", titleSource: "auto", title: "A" }))!;
    expect(e.session_id).toBe("local_z");
    expect(e.titleIsCustom).toBe(false);
  });

  test("parseIndexEntry rejects entries with no cwd or no id, and bad JSON", () => {
    expect(cowork.parseIndexEntry(JSON.stringify({ sessionId: "s" }))).toBeNull(); // no cwd
    expect(cowork.parseIndexEntry(JSON.stringify({ cwd: "/r" }))).toBeNull(); // no id
    expect(cowork.parseIndexEntry("{not json")).toBeNull();
  });
});
