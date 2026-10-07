// The host dimension: which machine a row came from (docs/FLEET.md, phase 1).
//
// The convention under test is the inversion: rows recorded here are stored
// with a NULL host and *read* as this machine's hostId(); only rows from
// another machine carry a value. Every assertion that matters is about that
// seam — a filter for "here" that compared `host = 'desk'` would silently
// return nothing, and a scope or a repo sweep that let another machine's
// `/home/you/x` through would mix two working trees into one.
//
// Driven against a throwaway DB, same as scope.test.ts: the bugs here are a
// missing WHERE clause, which a test on SQL fragments would never notice.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratch, scratchDir } from "./scratch.ts";

const dir = scratchDir(join(tmpdir(), "agx-fleet-host-"));
const PROJ = join(dir, "proj");
mkdirSync(PROJ, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "fleet.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_HOST_ID = "desk";
delete process.env.AGENTGLASS_ROOT;

let db: typeof import("../src/db.ts");
let config: typeof import("../src/config.ts");

const event = (session: string, over: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  source_app: "proj",
  session_id: session,
  event_id: null,
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-4-8",
  account: "work",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  cost_cumulative: null,
  reported_cost_usd: null,
  summary: "did a thing",
  timestamp: Date.now(),
  // Both machines worked in the same path — the case that must not merge.
  payload: { project_path: PROJ, ...payload },
  chat: null,
  ...over,
});

const EDIT = { hook_event_type: "PostToolUse", tool_name: "Edit" };
const editPayload = (file: string) => ({
  tool_input: { file_path: file },
  tool_response: { filePath: file, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] },
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  config = await import("../src/config.ts");
  db.insertEvent(event("fh-here") as any);
  db.insertEvent(event("fh-box", { host: "fh-box-host" }) as any);
  // A later write for the same session that does not name a host — Cowork
  // catalog metadata, say — must not move the session onto this machine.
  db.upsertSessionMeta({ session_id: "fh-box", source_app: "proj", started_at: Date.now(), last_seen: Date.now() });
  db.insertEvent(event("fh-here", EDIT, editPayload(join(PROJ, "here.ts"))) as any);
  db.insertEvent(event("fh-box", { ...EDIT, host: "fh-box-host" }, editPayload(join(PROJ, "box.ts"))) as any);
});

describe("host id", () => {
  test("comes from AGENTGLASS_HOST_ID when it is a plain label", () => {
    expect(config.hostId()).toBe("desk");
  });

  test("a value that is not a label is ignored, not trusted", () => {
    const was = process.env.AGENTGLASS_HOST_ID;
    process.env.AGENTGLASS_HOST_ID = "../../etc";
    try {
      const id = config.hostId();
      expect(id).not.toBe("../../etc");
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    } finally {
      process.env.AGENTGLASS_HOST_ID = was;
    }
  });

  test("NULL and this machine's own name are both local", () => {
    expect(config.isLocalHost(null)).toBe(true);
    expect(config.isLocalHost(undefined)).toBe(true);
    expect(config.isLocalHost("desk")).toBe(true);
    expect(config.isLocalHost("fh-box-host")).toBe(false);
  });
});

describe("storage", () => {
  test("a row recorded here is stored NULL — no stamp, nothing to backfill", () => {
    const rows = db.db
      .query<{ host: string | null }, [string]>("SELECT host FROM events WHERE session_id = ?")
      .all("fh-here");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.host === null)).toBe(true);
  });

  test("but every reader gets a name", () => {
    const here = db.getRecent(500).filter((e) => e.session_id === "fh-here");
    expect(here.length).toBeGreaterThan(0);
    expect(here.every((e) => e.host === "desk")).toBe(true);
  });

  test("a session's host is settled by its first row and never moves", () => {
    const box = db.getSessions(100).find((s) => s.session_id === "fh-box");
    expect(box?.host).toBe("fh-box-host");
  });

  test("normalize() never reads a host off an ingest body", async () => {
    const { normalize } = await import("../src/ingest.ts");
    const n = normalize({
      source_app: "proj",
      session_id: "s-claims",
      hook_event_type: "PostToolUse",
      payload: { cwd: PROJ },
      host: "fh-box-host",
    } as any);
    expect(n.host).toBeUndefined();
  });
});

describe("the host filter", () => {
  test("this machine's name selects the NULL rows", () => {
    const ids = new Set(db.getRecent(500, undefined, undefined, "desk").map((e) => e.session_id));
    expect(ids.has("fh-here")).toBe(true);
    expect(ids.has("fh-box")).toBe(false);
  });

  test("another machine's name selects only its rows", () => {
    const ids = new Set(db.getRecent(500, undefined, undefined, "fh-box-host").map((e) => e.session_id));
    expect(ids.has("fh-box")).toBe(true);
    expect(ids.has("fh-here")).toBe(false);
  });

  // Membership, not equality: `bun test` shares one process, and the database
  // this file opens may already hold sessions another suite wrote — all of
  // them local, which is exactly the side of the line they should land on.
  test("sessions filter the same way", () => {
    const box = db.getSessions(1000, undefined, undefined, "fh-box-host").map((s) => s.session_id);
    const desk = db.getSessions(1000, undefined, undefined, "desk").map((s) => s.session_id);
    expect(box).toEqual(["fh-box"]);
    expect(desk).toContain("fh-here");
    expect(desk).not.toContain("fh-box");
  });

  test("stats split by host reconcile with the total", () => {
    // Summed over every host the database holds, not two: `bun test` shares one
    // process and one database, and other suites leave their own machines' rows.
    const all = db.statsSummary(3600_000).totals.events;
    const desk = db.statsSummary(3600_000, undefined, undefined, undefined, "desk").totals.events;
    const box = db.statsSummary(3600_000, undefined, undefined, undefined, "fh-box-host").totals.events;
    expect(desk).toBeGreaterThan(0);
    expect(box).toBeGreaterThan(0);
    const each = (db.getFilterOptions().hosts ?? []).map((h) => db.statsSummary(3600_000, undefined, undefined, undefined, h).totals.events);
    expect(each.reduce((a, b) => a + b, 0)).toBe(all);
  });

  // The index is partial (foreign rows only) so `host IS NULL` can never be
  // steered onto it — stats-scope-index.test.ts pins that side. This pins the
  // other: a filter to another machine still reaches it, windowed.
  test("a filter to another machine is served by the foreign-host index", () => {
    const plan = db.db
      .query<{ detail: string }, [string, number]>(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE host = ? AND timestamp >= ?")
      .all("fh-box-host", 0)
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toContain("idx_events_foreign_host_ts");
  });

  test("the picker offers every machine seen, this one by name", () => {
    // Membership, not equality — other suites' machines may be in the same database.
    const hosts = db.getFilterOptions().hosts ?? [];
    expect(hosts).toContain("fh-box-host");
    expect(hosts).toContain("desk");
    expect(hosts).not.toContain(null as any);
  });
});

describe("another machine's paths are not ours to resolve", () => {
  test("the fleet-wide change list is this machine's only", () => {
    const files = db.getChanges(100).map((c) => c.file_path);
    expect(files).toContain(join(PROJ, "here.ts"));
    expect(files).not.toContain(join(PROJ, "box.ts"));
  });

  test("one session's deep-dive still shows its own changes — they come from the payload", () => {
    const files = db.getSession("fh-box")?.changes.map((c) => c.file_path) ?? [];
    expect(files).toContain(join(PROJ, "box.ts"));
  });

  test("a scoped cockpit is a project on this machine, not a path string", () => {
    process.env.AGENTGLASS_ROOT = PROJ;
    try {
      const ids = new Set(db.getRecent(500).map((e) => e.session_id));
      expect(ids.has("fh-here")).toBe(true);
      expect(ids.has("fh-box")).toBe(false);
      expect(db.getSessions(100).map((s) => s.session_id)).not.toContain("fh-box");
      expect(config.sessionInScope({ project_path: PROJ, host: "fh-box-host" })).toBe(false);
      expect(config.sessionInScope({ project_path: PROJ, host: "desk" })).toBe(true);
    } finally {
      delete process.env.AGENTGLASS_ROOT;
    }
  });

  test("an open call on another machine is not vouched for by a local file", async () => {
    const { withEvidence } = await import("../src/evidence.ts");
    const target = join(PROJ, "same-path.ts");
    writeFileSync(target, "x");
    const since = Date.now() - 1000;
    const call = { session_id: "s", source_app: "proj", tool_name: "Write", since, target };
    const [local, foreign] = withEvidence([
      { ...call, host: "desk" },
      { ...call, session_id: "s2", host: "fh-box-host" },
    ]);
    expect(local.evidenceKind).toBe("target");
    expect(foreign.evidenceKind).toBe("none");
  });
});

afterAll(removeScratch);
