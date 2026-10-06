/**
 * The fleet link's wire format — what one agentglass forwards to another.
 *
 * docs/FLEET.md has the shape of the whole thing. In one line: a node holds a
 * WebSocket open to a hub and streams the rows it has *already* ingested —
 * deduped, priced, worktree-resolved on the machine that ran the session — and
 * the hub stores them under the node's host name.
 *
 * Both ends import this file, and it is pure on purpose: everything the hub
 * believes about a frame is decided here, where a test can reach it without a
 * socket or a database.
 *
 *   node → hub   hello    { t, v, host, version }
 *   hub  → node  welcome  { t, v, host, after }      `after` = last origin id stored
 *   node → hub   rows     { t, upto, events, sessions }   events may be empty: a session resync
 *   hub  → node  ack      { t, upto }
 *   hub  → node  refuse   { t, error }               then closes
 *
 * Phase 3 — gates held on the node, answered at the hub:
 *
 *   node → hub   gates    { t, gates }                    the node's whole queue, on every change
 *   hub  → node  decide   { t, id, decision, reason, by } a person at the hub answered one
 *   node → hub   decided  { t, id, ok, error? }           whether it took (it may have timed out)
 *
 * Phase 4 — the hub reading a node's workspace (git, files) through it:
 *
 *   hub  → node  req      { t, rid, method, path, query, body?, scope?, stream? }
 *   node → hub   res      { t, rid, status, type, body }
 *
 * Second tier — a chat turn, whose answer is a stream that can run for minutes:
 *
 *   node → hub   res-head { t, rid, status, type }
 *   node → hub   res-data { t, rid, chunk }             zero or more, in order
 *   node → hub   res-end  { t, rid }
 *   hub  → node  cancel   { t, rid }                     the person stopped the turn
 *
 * `scope` is the hub caller's; the node runs the request with the lower of it
 * and its own tier. `hello` says which tier the node is at, so the hub can
 * offer Resume only where it would be taken.
 *
 * The node decides what it will run (`tunnelAllows` in auth.ts) and runs it
 * against its own router, under its own scope; the hub only carries it.
 *
 * `decide` can arrive at any moment — in the middle of a batch waiting for its
 * ack — so the node handles it the moment it lands rather than queueing it
 * behind the ack it is waiting for.
 *
 * One batch is in flight at a time; the node sends the next only after the
 * ack. The hub is the cursor's source of truth — a node that restarts, or
 * reconnects after a night asleep, asks where it got to rather than
 * remembering, so the two can never disagree about what was delivered.
 */

export const FLEET_PROTOCOL = 1;

/**
 * The events columns that travel, and only these.
 *
 * Named rather than `SELECT *`-and-forward because the two ends will not
 * always run the same build. A column a newer node has and an older hub does
 * not is dropped here instead of failing the insert, and a column neither side
 * should trust from the other (`id`, `host`, the generated path columns) is
 * never on the list to begin with. `id` travels separately as `origin_id`.
 */
export const EVENT_COLUMNS = [
  "source_app", "session_id", "event_id", "hook_event_type", "tool_name", "tool_use_id",
  "agent_id", "agent_type", "model_name", "provider", "account", "is_error", "error_text",
  "duration_ms", "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
  "cost_usd", "summary", "payload", "timestamp", "paired",
] as const;

/**
 * The sessions columns that travel. The hub mirrors these verbatim rather than
 * re-deriving them from the events, so a session's totals on the hub are the
 * node's totals by construction — re-adding forwarded deltas would drift the
 * moment one batch was retried or one row was pruned on one side first.
 */
export const SESSION_COLUMNS = [
  "session_id", "source_app", "model_name", "provider", "account", "project_path", "cwd_path",
  "started_at", "ended_at", "last_seen", "event_count", "tool_count", "error_count",
  "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens", "cost_usd",
  "custom_title", "ai_title",
] as const;

export type EventColumn = (typeof EVENT_COLUMNS)[number];
export type SessionColumn = (typeof SESSION_COLUMNS)[number];
export type WireEvent = { origin_id: number } & Partial<Record<EventColumn, string | number | null>>;
export type WireSession = Partial<Record<SessionColumn, string | number | null>>;

/** One held tool call, as a node forwards it. Mirrors PendingGate. */
export interface WireGate {
  id: string;
  source_app: string;
  session_id: string;
  tool_name: string;
  summary: string;
  created: number;
  expires: number;
  where?: string;
  budget?: string;
}

export type NodeFrame =
  | { t: "hello"; v: number; host: string; version?: string; tunnel?: TunnelTierWire; gates?: boolean }
  | { t: "rows"; upto: number; events: WireEvent[]; sessions: WireSession[] }
  | { t: "gates"; gates: WireGate[] }
  | { t: "decided"; id: string; ok: boolean; error?: string }
  | { t: "res"; rid: number; status: number; type: string; body: string }
  | { t: "res-head"; rid: number; status: number; type: string }
  | { t: "res-data"; rid: number; chunk: string }
  | { t: "res-end"; rid: number };
export type HubFrame =
  | { t: "welcome"; v: number; host: string; after: number }
  | { t: "ack"; upto: number }
  | { t: "refuse"; error: string }
  | { t: "decide"; id: string; decision: "allow" | "deny"; reason: string; by: string }
  | { t: "req"; rid: number; method: "GET" | "POST"; path: string; query: string; body?: string; scope?: ScopeWire; stream?: boolean }
  | { t: "cancel"; rid: number };

/** Kept as string unions here so this file stays free of server imports;
 *  auth.ts's Scope and TunnelTier are the same strings. */
export type ScopeWire = "read" | "answer" | "full";
export type TunnelTierWire = "off" | "read" | "answer" | "chat";
const SCOPES = new Set<string>(["read", "answer", "full"]);
const TIERS = new Set<string>(["off", "read", "answer", "chat"]);

/** A request body through the tunnel: a JSON argument, never an upload. */
export const MAX_TUNNEL_REQUEST = 64 * 1024;
/** A response through the tunnel — under the hub's frame ceiling with room
 *  for the frame's own JSON. A larger answer is refused on the node with a
 *  413 that says why, rather than truncated into something that parses. */
export const MAX_TUNNEL_RESPONSE = 3 * 1024 * 1024;

/** Same shape gate.ts accepts from a hook: a uuid, never anything else. */
export const GATE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** More holds than this at once is not a person's queue; it is a loop. */
export const MAX_GATES = 100;
const MAX_GATE_TEXT = 2000;
const MAX_REASON = 2000;
const MAX_ACTOR = 200;

const shortStr = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;

/** One forwarded hold, checked — or null. Text is capped, ids are uuids, and
 *  the two times have to be real times in the right order. */
export function cleanGate(raw: unknown): WireGate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !GATE_ID_RE.test(r.id)) return null;
  const source_app = shortStr(r.source_app, 200);
  const session_id = shortStr(r.session_id, 200);
  const tool_name = shortStr(r.tool_name, 200);
  const summary = shortStr(r.summary ?? "", MAX_GATE_TEXT);
  if (!source_app || !session_id || !tool_name || summary === null) return null;
  const created = r.created, expires = r.expires;
  if (typeof created !== "number" || !Number.isSafeInteger(created)) return null;
  if (typeof expires !== "number" || !Number.isSafeInteger(expires) || expires < created) return null;
  const where = r.where === undefined ? undefined : shortStr(r.where, 300);
  const budget = r.budget === undefined ? undefined : shortStr(r.budget, 300);
  if (where === null || budget === null) return null;
  return { id: r.id, source_app, session_id, tool_name, summary, created, expires,
    ...(where ? { where } : {}), ...(budget ? { budget } : {}) };
}

/** Same rule as hostId() in config.ts: a plain label, because it lands in a
 *  URL query, a filter option and a column every reader trusts. */
export const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * Batch ceilings, both ends. The node packs to these; the hub refuses beyond
 * them. 4 MB is a quarter of Bun's default WebSocket frame limit, and 500 rows
 * keeps one batch to one short transaction on the hub — which shares its
 * thread with every terminal the hub's own desk has open.
 */
export const MAX_BATCH_ROWS = 500;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;
/** Per string field, after JSON decoding. ingest.ts caps a live event's
 *  strings at 64 KB; the payload column holds the JSON of several of those, so
 *  it gets a little more room and nothing else does. */
const MAX_STRING = 64 * 1024;
const MAX_PAYLOAD = 256 * 1024;

const INT_EVENT = new Set<string>([
  "is_error", "duration_ms", "input_tokens", "output_tokens", "cache_creation_tokens",
  "cache_read_tokens", "timestamp", "paired",
]);
const REAL_EVENT = new Set<string>(["cost_usd"]);
const INT_SESSION = new Set<string>([
  "started_at", "ended_at", "last_seen", "event_count", "tool_count", "error_count",
  "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
]);
const REAL_SESSION = new Set<string>(["cost_usd"]);
/** Columns NOT NULL on the hub's own tables; a row missing one is refused
 *  rather than inserted with a guess. */
const EVENT_REQUIRED = ["source_app", "session_id", "hook_event_type", "timestamp"] as const;
const SESSION_REQUIRED = ["session_id", "source_app", "started_at", "last_seen"] as const;

/** A node's clock may be wrong, but not by this much: a row from tomorrow
 *  would sit at the top of every "latest" list until tomorrow came. */
const FUTURE_SLACK_MS = 24 * 3600_000;

function cell(
  col: string, v: unknown, ints: Set<string>, reals: Set<string>, max: number,
): { ok: true; value: string | number | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (ints.has(col)) {
    return typeof v === "number" && Number.isSafeInteger(v) ? { ok: true, value: v } : { ok: false };
  }
  if (reals.has(col)) {
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? { ok: true, value: v } : { ok: false };
  }
  return typeof v === "string" && v.length <= max ? { ok: true, value: v } : { ok: false };
}

/**
 * One forwarded event, made into exactly the row the hub will write — or null.
 *
 * Every column is type-checked against the hub's own schema and capped; an
 * unknown key is dropped, not refused, so a newer node keeps working against an
 * older hub. `payload` must be a JSON object, because the hub's generated
 * `project_path`/`cwd_path` columns extract from it and a scalar would make
 * every scoped query on the hub throw.
 */
export function cleanEvent(raw: unknown, now = Date.now()): WireEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.origin_id !== "number" || !Number.isSafeInteger(r.origin_id) || r.origin_id <= 0) return null;
  const out: WireEvent = { origin_id: r.origin_id };
  for (const col of EVENT_COLUMNS) {
    const c = cell(col, r[col], INT_EVENT, REAL_EVENT, col === "payload" ? MAX_PAYLOAD : MAX_STRING);
    if (!c.ok) return null;
    out[col] = c.value;
  }
  for (const col of EVENT_REQUIRED) if (out[col] === null || out[col] === "") return null;
  if ((out.timestamp as number) > now + FUTURE_SLACK_MS) return null;
  if (out.payload !== null) {
    try {
      const p = JSON.parse(out.payload as string);
      if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    } catch { return null; }
  } else {
    out.payload = "{}";
  }
  return out;
}

/** Same contract as cleanEvent, for a mirrored session row. */
export function cleanSession(raw: unknown): WireSession | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: WireSession = {};
  for (const col of SESSION_COLUMNS) {
    const c = cell(col, r[col], INT_SESSION, REAL_SESSION, MAX_STRING);
    if (!c.ok) return null;
    out[col] = c.value;
  }
  for (const col of SESSION_REQUIRED) if (out[col] === null || out[col] === "") return null;
  return out;
}

/**
 * A frame from a node, parsed and checked, or a reason it was refused.
 *
 * A batch with ANY bad row is refused whole rather than partly stored. Partial
 * storage would ack a cursor past rows that never landed — the one failure the
 * cursor exists to make impossible — and a node that sends a malformed row has
 * a bug worth hearing about, not working around.
 */
export function parseNodeFrame(text: string, now = Date.now()):
  | { ok: true; frame: NodeFrame }
  | { ok: false; error: string } {
  if (text.length > MAX_BATCH_BYTES) return { ok: false, error: "frame too large" };
  let f: Record<string, unknown>;
  try { f = JSON.parse(text); } catch { return { ok: false, error: "not JSON" }; }
  if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, error: "not an object" };
  if (f.t === "hello") {
    if (f.v !== FLEET_PROTOCOL) return { ok: false, error: `protocol ${String(f.v)} is not ${FLEET_PROTOCOL}` };
    if (typeof f.host !== "string" || !HOST_ID_RE.test(f.host)) return { ok: false, error: "bad host" };
    return { ok: true, frame: {
      t: "hello", v: f.v, host: f.host,
      version: typeof f.version === "string" ? f.version.slice(0, 40) : undefined,
      tunnel: typeof f.tunnel === "string" && TIERS.has(f.tunnel) ? f.tunnel as TunnelTierWire : undefined,
      gates: typeof f.gates === "boolean" ? f.gates : undefined,
    } };
  }
  if (f.t === "gates") {
    if (!Array.isArray(f.gates) || f.gates.length > MAX_GATES) return { ok: false, error: "bad gates" };
    const gates: WireGate[] = [];
    for (const raw of f.gates) {
      const g = cleanGate(raw);
      if (!g) return { ok: false, error: "bad gate" };
      gates.push(g);
    }
    return { ok: true, frame: { t: "gates", gates } };
  }
  if (f.t === "decided") {
    if (typeof f.id !== "string" || !GATE_ID_RE.test(f.id) || typeof f.ok !== "boolean") return { ok: false, error: "bad decided" };
    const error = typeof f.error === "string" ? f.error.slice(0, 300) : undefined;
    return { ok: true, frame: { t: "decided", id: f.id, ok: f.ok, ...(error ? { error } : {}) } };
  }
  if (f.t === "res-head" || f.t === "res-data" || f.t === "res-end") {
    if (typeof f.rid !== "number" || !Number.isSafeInteger(f.rid) || f.rid <= 0) return { ok: false, error: "bad stream frame" };
    if (f.t === "res-end") return { ok: true, frame: { t: "res-end", rid: f.rid } };
    if (f.t === "res-data") {
      if (typeof f.chunk !== "string" || f.chunk.length > MAX_TUNNEL_RESPONSE) return { ok: false, error: "bad stream frame" };
      return { ok: true, frame: { t: "res-data", rid: f.rid, chunk: f.chunk } };
    }
    if (typeof f.status !== "number" || !Number.isInteger(f.status) || f.status < 100 || f.status > 599) return { ok: false, error: "bad stream frame" };
    if (typeof f.type !== "string" || f.type.length > 200) return { ok: false, error: "bad stream frame" };
    return { ok: true, frame: { t: "res-head", rid: f.rid, status: f.status, type: f.type } };
  }
  if (f.t === "res") {
    if (typeof f.rid !== "number" || !Number.isSafeInteger(f.rid) || f.rid <= 0) return { ok: false, error: "bad res" };
    if (typeof f.status !== "number" || !Number.isInteger(f.status) || f.status < 100 || f.status > 599) return { ok: false, error: "bad res" };
    if (typeof f.type !== "string" || f.type.length > 200 || typeof f.body !== "string" || f.body.length > MAX_TUNNEL_RESPONSE) {
      return { ok: false, error: "bad res" };
    }
    return { ok: true, frame: { t: "res", rid: f.rid, status: f.status, type: f.type, body: f.body } };
  }
  if (f.t === "rows") {
    // 0 is a real cursor: a sessions-only resync from a node that has not
    // forwarded an event yet.
    if (typeof f.upto !== "number" || !Number.isSafeInteger(f.upto) || f.upto < 0) return { ok: false, error: "bad upto" };
    if (!Array.isArray(f.events) || !Array.isArray(f.sessions)) return { ok: false, error: "bad rows" };
    if (f.events.length + f.sessions.length > MAX_BATCH_ROWS * 2) return { ok: false, error: "too many rows" };
    const events: WireEvent[] = [];
    for (const raw of f.events) {
      const e = cleanEvent(raw, now);
      if (!e) return { ok: false, error: "bad event row" };
      // The cursor is a promise that everything up to it was in this batch or
      // an earlier one; a row past it would be acked twice or never.
      if (e.origin_id > f.upto) return { ok: false, error: "event past upto" };
      events.push(e);
    }
    const sessions: WireSession[] = [];
    for (const raw of f.sessions) {
      const s = cleanSession(raw);
      if (!s) return { ok: false, error: "bad session row" };
      sessions.push(s);
    }
    return { ok: true, frame: { t: "rows", upto: f.upto, events, sessions } };
  }
  return { ok: false, error: "unknown frame" };
}

/** A frame from the hub, as the node reads it. Looser than the hub's check —
 *  the node chose to connect here — but never trusting a shape it did not ask
 *  for. */
export function parseHubFrame(text: string): HubFrame | null {
  let f: Record<string, unknown>;
  try { f = JSON.parse(text); } catch { return null; }
  if (!f || typeof f !== "object") return null;
  if (f.t === "welcome" && typeof f.host === "string" && typeof f.after === "number" && Number.isSafeInteger(f.after) && f.after >= 0) {
    return { t: "welcome", v: Number(f.v), host: f.host, after: f.after };
  }
  if (f.t === "ack" && typeof f.upto === "number" && Number.isSafeInteger(f.upto)) return { t: "ack", upto: f.upto };
  if (f.t === "refuse") return { t: "refuse", error: String(f.error ?? "refused").slice(0, 300) };
  // Checked as strictly as the hub checks a node: this frame releases a held
  // tool call on this machine, so a malformed one is no answer at all.
  if (f.t === "decide") {
    if (typeof f.id !== "string" || !GATE_ID_RE.test(f.id)) return null;
    if (f.decision !== "allow" && f.decision !== "deny") return null;
    const reason = shortStr(f.reason ?? "", MAX_REASON);
    const by = shortStr(f.by ?? "", MAX_ACTOR);
    if (reason === null || by === null) return null;
    return { t: "decide", id: f.id, decision: f.decision, reason, by };
  }
  if (f.t === "req") {
    if (typeof f.rid !== "number" || !Number.isSafeInteger(f.rid) || f.rid <= 0) return null;
    if (f.method !== "GET" && f.method !== "POST") return null;
    // A path, not a URL: no scheme, no host, nothing that could make the node's
    // own Request point anywhere but itself.
    if (typeof f.path !== "string" || !f.path.startsWith("/") || f.path.length > 512 || /[\s?#]/.test(f.path)) return null;
    const query = typeof f.query === "string" && f.query.length <= 4096 && !f.query.includes("#") ? f.query.replace(/^\?/, "") : null;
    if (query === null) return null;
    const body = f.body === undefined ? undefined : shortStr(f.body, MAX_TUNNEL_REQUEST);
    if (body === null) return null;
    // Absent means the narrowest: a hub too old to say whose request it is
    // gets read access, never more.
    const scope = typeof f.scope === "string" && SCOPES.has(f.scope) ? f.scope as ScopeWire : undefined;
    return { t: "req", rid: f.rid, method: f.method, path: f.path, query,
      ...(body !== undefined ? { body } : {}), ...(scope ? { scope } : {}), ...(f.stream === true ? { stream: true } : {}) };
  }
  if (f.t === "cancel") {
    if (typeof f.rid !== "number" || !Number.isSafeInteger(f.rid) || f.rid <= 0) return null;
    return { t: "cancel", rid: f.rid };
  }
  return null;
}

/**
 * Where a node may send its rows without anyone on the path reading them.
 *
 * The link carries prompts, file contents and command output, and the node's
 * credential rides in its first request — so plain `ws://` across a LAN would
 * hand both to anything on the wifi. Allowed in the clear: this machine (an
 * `ssh -L` tunnel) and a tailnet address, which WireGuard already encrypts.
 * Everything else must be `https:`/`wss:`. `insecure` is the deliberate
 * override, for somebody who has their own reasons.
 */
export function linkTransportOk(url: URL, insecure = false): boolean {
  if (url.protocol === "https:" || url.protocol === "wss:") return true;
  if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
  if (insecure) return true;
  const h = url.hostname.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  // 100.64.0.0/10 — the CGNAT range Tailscale hands out — and its MagicDNS names.
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
  if (h.endsWith(".ts.net")) return true;
  return false;
}

/** The hub's link endpoint for a configured hub URL: http→ws, https→wss. */
export function linkUrl(hub: string): URL {
  const u = new URL(hub);
  u.protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/fleet/link";
  u.search = "";
  u.hash = "";
  return u;
}
