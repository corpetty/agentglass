// What the hub believes about a frame from a node — decided in fleetwire.ts —
// and what a node credential may do once it has one (auth.ts).
//
// The hub stores forwarded rows without re-deriving them, so these checks are
// the whole of what stands between another machine's bug and this machine's
// tables. Each test below is a row or frame that must not get in, or a reason
// a valid one must not be turned away.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanEvent, cleanGate, cleanSession, linkTransportOk, linkUrl, parseNodeFrame, parseHubFrame, FLEET_PROTOCOL, MAX_GATES,
} from "../src/fleetwire.ts";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "agx-fleet-wire-"));

const ev = (over: Record<string, unknown> = {}) => ({
  origin_id: 7, source_app: "proj", session_id: "s1", event_id: null, hook_event_type: "PostToolUse",
  tool_name: "Bash", tool_use_id: "t1", agent_id: null, agent_type: null, model_name: "claude-opus-4-8",
  provider: "anthropic", account: "work", is_error: 0, error_text: null, duration_ms: 12,
  input_tokens: 1, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.01,
  summary: null, payload: JSON.stringify({ cwd: "/home/u/proj" }), timestamp: Date.now(), paired: 0,
  ...over,
});
const sess = (over: Record<string, unknown> = {}) => ({
  session_id: "s1", source_app: "proj", model_name: null, provider: null, account: "work",
  project_path: "/home/u/proj", cwd_path: null, started_at: 1, ended_at: null, last_seen: 2,
  event_count: 1, tool_count: 1, error_count: 0, input_tokens: 1, output_tokens: 2,
  cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0.01, custom_title: null, ai_title: null,
  ...over,
});

describe("a forwarded event row", () => {
  test("a well-formed row passes, carrying only known columns", () => {
    const e = cleanEvent({ ...ev(), host: "evil", id: 1, project_path: "/x", surprise: 1 });
    expect(e).not.toBeNull();
    expect(e!.origin_id).toBe(7);
    // The columns a node must never set on the hub's copy are not on the list.
    for (const k of ["host", "id", "project_path", "surprise"]) expect(k in e!).toBe(false);
  });

  test("a wrong type is refused rather than coerced", () => {
    expect(cleanEvent(ev({ input_tokens: "10" }))).toBeNull();
    expect(cleanEvent(ev({ cost_usd: -1 }))).toBeNull();
    expect(cleanEvent(ev({ timestamp: 1.5 }))).toBeNull();
  });

  test("a row missing what the hub's NOT NULL columns need is refused", () => {
    expect(cleanEvent(ev({ session_id: null }))).toBeNull();
    expect(cleanEvent(ev({ hook_event_type: "" }))).toBeNull();
    expect(cleanEvent({ ...ev(), origin_id: 0 })).toBeNull();
  });

  test("the payload must be a JSON object — the hub's generated path columns extract from it", () => {
    expect(cleanEvent(ev({ payload: "[1,2]" }))).toBeNull();
    expect(cleanEvent(ev({ payload: "not json" }))).toBeNull();
    expect(cleanEvent(ev({ payload: null }))!.payload).toBe("{}");
  });

  test("a row from tomorrow is refused; one from last week is history", () => {
    expect(cleanEvent(ev({ timestamp: Date.now() + 2 * 86_400_000 }))).toBeNull();
    expect(cleanEvent(ev({ timestamp: Date.now() - 7 * 86_400_000 }))).not.toBeNull();
  });

  test("oversized strings are refused", () => {
    expect(cleanEvent(ev({ summary: "x".repeat(70_000) }))).toBeNull();
  });
});

describe("a node frame", () => {
  test("hello must speak this protocol and name a plain host", () => {
    expect(parseNodeFrame(JSON.stringify({ t: "hello", v: FLEET_PROTOCOL, host: "bean" })).ok).toBe(true);
    expect(parseNodeFrame(JSON.stringify({ t: "hello", v: 99, host: "bean" })).ok).toBe(false);
    expect(parseNodeFrame(JSON.stringify({ t: "hello", v: FLEET_PROTOCOL, host: "../etc" })).ok).toBe(false);
  });

  test("one bad row refuses the whole batch — a partial store would ack rows that never landed", () => {
    const r = parseNodeFrame(JSON.stringify({ t: "rows", upto: 9, events: [ev(), ev({ input_tokens: "x" })], sessions: [] }));
    expect(r.ok).toBe(false);
  });

  test("an event past the cursor it is acked under is refused", () => {
    const r = parseNodeFrame(JSON.stringify({ t: "rows", upto: 5, events: [ev({ origin_id: 6 })], sessions: [] }));
    expect(r).toEqual({ ok: false, error: "event past upto" });
  });

  test("a sessions-only resync at cursor 0 is a real frame", () => {
    const r = parseNodeFrame(JSON.stringify({ t: "rows", upto: 0, events: [], sessions: [sess()] }));
    expect(r.ok).toBe(true);
  });

  test("a session row is checked like an event row", () => {
    expect(cleanSession(sess())).not.toBeNull();
    expect(cleanSession(sess({ started_at: null }))).toBeNull();
    expect(cleanSession(sess({ event_count: "1" }))).toBeNull();
  });

  test("the hub's answers parse; anything else is not one", () => {
    expect(parseHubFrame(JSON.stringify({ t: "welcome", v: 1, host: "hub", after: 3 }))).toEqual({ t: "welcome", v: 1, host: "hub", after: 3 });
    expect(parseHubFrame(JSON.stringify({ t: "ack", upto: 3 }))).toEqual({ t: "ack", upto: 3 });
    expect(parseHubFrame(JSON.stringify({ t: "welcome", host: "hub", after: -1 }))).toBeNull();
  });
});

describe("where a node may send its rows", () => {
  test("https anywhere; plain http only to this machine or the tailnet", () => {
    expect(linkTransportOk(new URL("https://hub.example.com"))).toBe(true);
    expect(linkTransportOk(new URL("http://127.0.0.1:4000"))).toBe(true);
    expect(linkTransportOk(new URL("http://localhost:4100"))).toBe(true);
    expect(linkTransportOk(new URL("http://100.101.102.103:4000"))).toBe(true);
    expect(linkTransportOk(new URL("http://box.tail1234.ts.net:4000"))).toBe(true);
    expect(linkTransportOk(new URL("http://192.168.1.20:4000"))).toBe(false);
    // 100.0/10 is not the CGNAT block; only 100.64/10 is.
    expect(linkTransportOk(new URL("http://100.10.0.1:4000"))).toBe(false);
    expect(linkTransportOk(new URL("http://192.168.1.20:4000"), true)).toBe(true);
  });

  test("the link URL follows the hub URL's scheme", () => {
    expect(linkUrl("https://hub.example.com/").href).toBe("wss://hub.example.com/fleet/link");
    expect(linkUrl("http://100.64.0.1:4000").href).toBe("ws://100.64.0.1:4000/fleet/link");
  });
});

describe("a node credential", () => {
  test("opens the link and nothing else, and never releases a hold", async () => {
    const { issueDevice } = await import("../src/devices.ts");
    const { callerFor, allowed, answersFromADevice } = await import("../src/auth.ts");
    const { token, device } = issueDevice("agentglass on bean", "full", Date.now(), { host: "bean" });
    // Whatever scope was asked for, a node is minted at the narrowest.
    expect(device.scope).toBe("read");
    const req = new Request("http://127.0.0.1/fleet/link", { headers: { Authorization: `Bearer ${token}` } });
    const caller = callerFor(req, new URL(req.url), "machine-token")!;
    expect(caller.principal).toBe("node");
    expect(allowed(caller, "GET", "/fleet/link")).toBe(true);
    expect(allowed(caller, "GET", "/sessions")).toBe(false);
    expect(allowed(caller, "GET", "/stream")).toBe(false);
    expect(allowed(caller, "POST", "/gate/decide")).toBe(false);
    expect(answersFromADevice(caller)).toBe(false);
  });
});

describe("phase 3: holds and answers", () => {
  const gate = (over: Record<string, unknown> = {}) => ({
    id: "0f8fad5b-d9cb-469f-a165-70867728950e", source_app: "proj", session_id: "s1", tool_name: "Bash",
    summary: "rm -rf build", created: 1000, expires: 61_000, where: "proj · main", ...over,
  });

  test("a forwarded hold is checked like a row", () => {
    expect(cleanGate(gate())).not.toBeNull();
    expect(cleanGate(gate({ id: "not-a-uuid" }))).toBeNull();
    expect(cleanGate(gate({ expires: 500 }))).toBeNull();      // ends before it began
    expect(cleanGate(gate({ summary: "x".repeat(3000) }))).toBeNull();
    expect(cleanGate(gate({ tool_name: "" }))).toBeNull();
  });

  test("a queue longer than a person's is refused", () => {
    const many = Array.from({ length: MAX_GATES + 1 }, () => gate({ id: crypto.randomUUID() }));
    expect(parseNodeFrame(JSON.stringify({ t: "gates", gates: many })).ok).toBe(false);
    expect(parseNodeFrame(JSON.stringify({ t: "gates", gates: [gate()] })).ok).toBe(true);
  });

  test("an answer from the hub must be exactly an answer — it releases a call on the node", () => {
    const ok = { t: "decide", id: "0f8fad5b-d9cb-469f-a165-70867728950e", decision: "deny", reason: "no", by: "local" };
    expect(parseHubFrame(JSON.stringify(ok))).toEqual(ok as any);
    expect(parseHubFrame(JSON.stringify({ ...ok, decision: "maybe" }))).toBeNull();
    expect(parseHubFrame(JSON.stringify({ ...ok, id: "../x" }))).toBeNull();
    expect(parseHubFrame(JSON.stringify({ ...ok, reason: "x".repeat(5000) }))).toBeNull();
  });

  test("the node's confirmation is checked too", () => {
    expect(parseNodeFrame(JSON.stringify({ t: "decided", id: "0f8fad5b-d9cb-469f-a165-70867728950e", ok: false, error: "late" })).ok).toBe(true);
    expect(parseNodeFrame(JSON.stringify({ t: "decided", id: "nope", ok: true })).ok).toBe(false);
  });
});


describe("phase 4: what a hub may read on a node", () => {
  test("the workspace views, read-only — and nothing else", async () => {
    const { tunnelAllows } = await import("../src/auth.ts");
    for (const [m, p] of [["GET", "/git/log"], ["GET", "/git/file-diff"], ["POST", "/git/status"], ["GET", "/files/tree"], ["GET", "/changes"], ["GET", "/fs/complete"]]) {
      expect(tunnelAllows(m!, p!)).toBe(true);
    }
    for (const [m, p] of [
      ["POST", "/git/stage"], ["POST", "/git/commit"], ["POST", "/git/push"],   // writes
      ["GET", "/terminal/pty"], ["GET", "/sessions"], ["GET", "/stream"],      // outside the workspace views
      ["POST", "/chat/send"], ["POST", "/gate/decide"], ["POST", "/fleet/proxy"],
      ["GET", "/git/../sessions"], ["GET", "/git//x"],                          // shapes that are not a plain path
    ]) {
      expect(tunnelAllows(m!, p!)).toBe(false);
    }
  });

  test("a request frame is a path, not a URL", () => {
    const ok = { t: "req", rid: 1, method: "GET", path: "/git/log", query: "root=%2Fx" };
    expect(parseHubFrame(JSON.stringify(ok))).toEqual(ok as any);
    expect(parseHubFrame(JSON.stringify({ ...ok, path: "http://evil/git/log" }))).toBeNull();
    expect(parseHubFrame(JSON.stringify({ ...ok, path: "/git/log?x=1" }))).toBeNull();
    expect(parseHubFrame(JSON.stringify({ ...ok, method: "DELETE" }))).toBeNull();
    expect(parseHubFrame(JSON.stringify({ ...ok, body: "x".repeat(70_000) }))).toBeNull();
  });
});
