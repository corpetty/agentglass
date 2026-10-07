// Storing another machine's batch on the hub, and reading this machine's rows
// out to forward (fleetstore.ts).
//
// The properties that matter are about the cursor and about ownership: a
// retried batch lands once, the cursor never runs ahead of what was stored, a
// mirrored session is the node's numbers exactly, and nothing forwarded can
// overwrite a session this machine — or a third one — recorded.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-fleet-store-"));
process.env.AGENTGLASS_DB ||= join(dir, "fleet.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_HOST_ID = "hub";

let db: typeof import("../src/db.ts");
let store: typeof import("../src/fleetstore.ts");

const SID = `fs-${Date.now()}`;
const ev = (origin_id: number, over: Record<string, unknown> = {}) => ({
  origin_id, source_app: "proj", session_id: SID, event_id: null, hook_event_type: "PostToolUse",
  tool_name: "Bash", tool_use_id: `tu-${origin_id}`, agent_id: null, agent_type: null,
  model_name: "claude-opus-4-8", provider: "anthropic", account: "work", is_error: 0, error_text: null,
  duration_ms: 5, input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 0,
  cost_usd: 0.5, summary: null, payload: JSON.stringify({ cwd: "/home/u/proj" }), timestamp: Date.now(), paired: 0,
  ...over,
});
const sess = (over: Record<string, unknown> = {}) => ({
  session_id: SID, source_app: "proj", model_name: "claude-opus-4-8", provider: "anthropic", account: "work",
  project_path: "/home/u/proj", cwd_path: null, started_at: Date.now() - 1000, ended_at: null, last_seen: Date.now(),
  event_count: 2, tool_count: 2, error_count: 0, input_tokens: 20, output_tokens: 40,
  cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 1, custom_title: "the box's title", ai_title: null,
  ...over,
});

beforeAll(async () => {
  db = await import("../src/db.ts");
  store = await import("../src/fleetstore.ts");
});

describe("applying a batch", () => {
  test("rows land under the node's host and the cursor advances with them", () => {
    store.noteNode("box", "test");
    const r = store.applyBatch("box", 2, [ev(1), ev(2)] as any, [sess()] as any);
    expect(r.inserted.length).toBe(2);
    expect(store.nodeCursor("box")).toBe(2);
    const hosts = db.db.query<{ host: string | null }, [string]>("SELECT host FROM events WHERE session_id = ?").all(SID);
    expect(hosts.map((h) => h.host)).toEqual(["box", "box"]);
  });

  test("a retried batch lands once", () => {
    const r = store.applyBatch("box", 2, [ev(1), ev(2)] as any, [sess()] as any);
    expect(r.inserted).toEqual([]);
    const n = db.db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM events WHERE session_id = ?").get(SID)!.n;
    expect(n).toBe(2);
  });

  test("the cursor never moves backwards", () => {
    store.applyBatch("box", 1, [], [] as any);
    expect(store.nodeCursor("box")).toBe(2);
  });

  test("a session is mirrored as sent, not summed from the events", () => {
    const s = db.sessionsByIds([SID])[0]!;
    expect(s.host).toBe("box");
    expect(s.event_count).toBe(2);
    expect(s.cost_usd).toBe(1);
    expect(s.custom_title).toBe("the box's title");
    store.applyBatch("box", 2, [], [sess({ event_count: 9, ai_title: "renamed later" })] as any);
    const again = db.sessionsByIds([SID])[0]!;
    expect(again.event_count).toBe(9);
    expect(again.ai_title).toBe("renamed later");
  });

  test("an id this machine already holds is stored under the node's name instead", () => {
    const shared = `unknown-${Date.now()}`;
    db.upsertSessionMeta({ session_id: shared, source_app: "here", started_at: 1, last_seen: 1 });
    store.applyBatch("box", 3, [ev(3, { session_id: shared })] as any, [sess({ session_id: shared })] as any);
    const local = db.sessionsByIds([shared])[0]!;
    expect(local.host).toBe("hub");       // untouched — still this machine's
    expect(local.source_app).toBe("here");
    const theirs = db.sessionsByIds([`box:${shared}`])[0]!;
    expect(theirs.host).toBe("box");
    // And the event followed the session to its new name.
    const e = db.db.query<{ session_id: string }, [number]>("SELECT session_id FROM events WHERE host = 'box' AND origin_id = ?").get(3)!;
    expect(e.session_id).toBe(`box:${shared}`);
  });

  test("a third machine cannot write over the second one's session", () => {
    store.applyBatch("rooter", 1, [], [sess({ custom_title: "rooter says" })] as any);
    expect(db.sessionsByIds([SID])[0]!.custom_title).toBe("the box's title");
    expect(db.sessionsByIds([`rooter:${SID}`])[0]!.custom_title).toBe("rooter says");
  });
});

describe("reading this machine's rows to forward", () => {
  test("only local rows are sent, but the cursor moves past the rest", () => {
    // Everything so far in this file is foreign (box, rooter). Add one local row.
    const n = db.insertEvent({
      source_app: "mine", session_id: `local-${SID}`, event_id: null, hook_event_type: "Stop",
      tool_name: null, tool_use_id: null, agent_id: null, agent_type: null, model_name: null, account: "work",
      is_error: 0, error_text: null, usage: {}, usage_is_cumulative: false, cost_cumulative: null,
      reported_cost_usd: null, summary: null, timestamp: Date.now(), payload: {}, chat: null,
    } as any);
    const max = db.db.query<{ m: number }, []>("SELECT MAX(id) m FROM events").get()!.m;
    const b = store.localBatch(0, 100_000, 64 * 1024 * 1024);
    expect(b.upto).toBe(max);
    expect(b.events.some((e) => e.session_id === `local-${SID}`)).toBe(true);
    expect(b.events.every((e) => e.session_id !== SID)).toBe(true);
    expect(b.events.find((e) => e.session_id === `local-${SID}`)!.origin_id).toBe(n.event.id);
  });

  test("a byte budget smaller than one row still sends that row", () => {
    const b = store.localBatch(0, 100_000, 1);
    expect(b.events.length).toBeLessThanOrEqual(1);
    expect(b.upto).toBeGreaterThan(0);
  });
});

describe("knowing a session is somewhere else", () => {
  test("a forwarded session, and a host-prefixed id, belong to their machine; a local one to nobody", () => {
    expect(db.foreignHostOf(SID)).toBe("box");
    expect(db.foreignHostOf("rooter:anything-at-all")).toBe("rooter");
    expect(db.foreignHostOf(`local-${SID}`)).toBeNull();
    expect(db.foreignHostOf("")).toBeNull();
  });
});
