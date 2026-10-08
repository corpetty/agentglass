// A session the scanner owns has its hook events turned away at /ingest, and
// AGENTGLASS_ACCOUNT used to go with them: two desktop instances sharing the
// default ~/.claude login had every session tagged `work`, whichever account
// ran it. What this pins: the account a hook names reaches the rows the
// scanner writes for that session, and a session whose hook named none keeps
// the old fallback.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-hookacct-"));
const PROJECTS = join(dir, "projects", "-tmp-hookacctproj");
mkdirSync(PROJECTS, { recursive: true });
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
process.env.AGENTGLASS_DB ||= join(dir, "hookacct.db");

const INDEX = await Bun.file(join(import.meta.dir, "..", "src", "index.ts")).text();

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
let CWD = join(dir, "hookacctproj");

const NAMED = "hookacct-named";
const SILENT = "hookacct-silent";
const FIXTURES = [NAMED, SILENT];

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-hookacct-fixture");
  mkdirSync(CWD, { recursive: true });
});

afterAll(() => {
  if (db) {
    const marks = FIXTURES.map(() => "?").join(",");
    for (const t of ["events", "sessions", "transcript_files", "session_account"]) {
      try { db.db.run(`DELETE FROM ${t} WHERE session_id IN (${marks})`, FIXTURES); } catch { /* column may not exist */ }
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const write = (sid: string) => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const rows = [
    { type: "user", cwd: CWD, sessionId: sid, timestamp: at, message: { role: "user", content: "rename the orbit flag" } },
    { type: "assistant", cwd: CWD, sessionId: sid, timestamp: at,
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "tool_use", id: `${sid}-t1`, name: "Bash", input: { command: "ls" } }] } },
    { type: "user", cwd: CWD, sessionId: sid, timestamp: at,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `${sid}-t1`, content: "README.md" }] } },
  ];
  writeFileSync(join(PROJECTS, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r) + "\n").join(""));
};
const accounts = (sid: string) =>
  db.db.query<{ account: string }, [string]>("SELECT DISTINCT account FROM events WHERE session_id = ?").all(sid).map((r) => r.account);
const sessionRow = (sid: string) =>
  db.db.query<{ account: string }, [string]>("SELECT account FROM sessions WHERE session_id = ?").get(sid)?.account ?? null;

describe("the account a hook names, on a session the scanner owns", () => {
  test("reaches every row the scanner writes for it", async () => {
    db.noteAccountFromHook({ session_id: NAMED, account: "personal" });
    write(NAMED);
    write(SILENT);
    await scan.scanOnce(null);

    expect(accounts(NAMED)).toEqual(["personal"]);
    expect(sessionRow(NAMED)).toBe("personal");
    // No hook named one: the login-dir and path fallbacks decide, as before.
    expect(accounts(SILENT).length).toBeGreaterThan(0);
    expect(accounts(SILENT)).not.toContain("personal");
  });

  test("is noted before /ingest turns the event away", () => {
    const route = INDEX.slice(INDEX.indexOf('if (pathname === "/ingest"'));
    const note = route.indexOf("noteAccountFromHook(body)");
    const skip = route.indexOf("if (ownsSession(body.session_id))");
    expect(note).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(-1);
    expect(note).toBeLessThan(skip);
  });

  test("follows a change, and ignores what is not an account", () => {
    db.noteAccountFromHook({ session_id: NAMED, account: "work" });
    expect(db.sessionAccount(NAMED)).toBe("work");
    db.noteAccountFromHook({ session_id: NAMED, account: "   " });
    db.noteAccountFromHook({ session_id: NAMED, account: "x".repeat(65) });
    db.noteAccountFromHook({ session_id: NAMED, account: 7 });
    db.noteAccountFromHook({ session_id: NAMED });
    expect(db.sessionAccount(NAMED)).toBe("work");
    expect(db.sessionAccount(SILENT)).toBeNull();
  });
});
