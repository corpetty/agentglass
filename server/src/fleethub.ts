/**
 * The hub end of the fleet link (docs/FLEET.md).
 *
 * index.ts authenticates the upgrade — only a node credential reaches
 * `/fleet/link`, and that credential is bound to one host name (devices.ts) —
 * and hands the socket here. What is decided here is everything after: that
 * the node says hello as the host its credential names, that every row it
 * sends survives fleetwire.ts's checks, and that each batch is stored whole
 * before it is acknowledged.
 *
 * A node is trusted to tell the truth about its own sessions and about nothing
 * else. It cannot name another host (the binding), cannot write a row this
 * machine recorded (every row it sends is stored under its host, and sessions
 * held by anyone else are steered around), and cannot reach anything on the
 * hub but this socket (`nodeAllows` in auth.ts).
 */
import type { ServerWebSocket } from "bun";
import { hostId } from "./config.ts";
import type { PendingGate } from "../../shared/types.ts";
import { FLEET_PROTOCOL, parseNodeFrame, type HubFrame, type WireGate } from "./fleetwire.ts";
import { applyBatch, fleetNodeRows, nodeCursor, noteNode, type AppliedBatch } from "./fleetstore.ts";

export interface FleetWsData {
  kind: "fleet";
  /** The host the credential is bound to — the only name this socket may use. */
  host: string;
  deviceId: string;
  ip?: string | null;
  greeted?: boolean;
  version?: string;
  connectedAt?: number;
  lastBatchAt?: number;
  rows?: number;
  helloTimer?: ReturnType<typeof setTimeout>;
}
type Ws = ServerWebSocket<FleetWsData>;

/** The socket currently speaking for each host. One per host: a newer link
 *  replaces an older one, because the usual reason for two is a node that
 *  reconnected before the hub noticed its last socket had died. */
const live = new Map<string, Ws>();

let onForeign: ((b: AppliedBatch) => void) | null = null;
/** Who hears that another machine's rows just landed (index.ts: the live
 *  socket). A hook rather than an import so this module never reaches into
 *  the server's broadcast plumbing. */
export function whenForeignRows(fn: ((b: AppliedBatch) => void) | null): void { onForeign = fn; }

const HELLO_MS = 10_000;

/*
 * Phase 3: the holds each node is keeping, as it last said (docs/FLEET.md).
 *
 * A snapshot per host, replaced whole on every `gates` frame and dropped when
 * the node's link closes — a hold nobody here can answer is not one to offer.
 * The hold itself never lives here: the node keeps it, times it out under its
 * own policy, and is the only place a decision takes effect.
 */
const remoteGates = new Map<string, Map<string, WireGate>>();
/** Decisions sent down a link and not yet answered, by gate id. */
const awaiting = new Map<string, { host: string; resolve: (r: { ok: boolean; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
const DECIDE_MS = 10_000;

let onRemoteGate: ((host: string, g: WireGate) => void) | null = null;
/** Who hears that a node started holding a call this hub had not seen
 *  (index.ts: the same alert a local hold raises, naming the machine). */
export function whenRemoteGate(fn: ((host: string, g: WireGate) => void) | null): void { onRemoteGate = fn; }

/** Every hold the linked nodes are keeping, shaped like this server's own. A
 *  hold already past its deadline is left out: the node has timed it out or
 *  is about to, and a button that can only lose is not worth drawing. */
export function remotePendingGates(now = Date.now()): PendingGate[] {
  const out: PendingGate[] = [];
  for (const [host, gates] of remoteGates) {
    for (const g of gates.values()) {
      if (g.expires <= now) continue;
      out.push({ id: g.id, source_app: g.source_app, session_id: g.session_id, tool_name: g.tool_name,
        summary: g.summary, created: g.created, expires: g.expires, where: g.where, host });
    }
  }
  return out.sort((a, b) => a.created - b.created);
}

/** The node holding this gate, if a linked node is. */
export function remoteGate(id: string): (WireGate & { host: string }) | null {
  for (const [host, gates] of remoteGates) {
    const g = gates.get(id);
    if (g) return { ...g, host };
  }
  return null;
}

/**
 * Send a person's answer to the node holding the call, and say whether it took.
 *
 * Whether it took is the node's to say — the hold may have timed out there a
 * moment ago, or been answered at that machine's own desk — so this waits for
 * the node's `decided` rather than assuming. `by` is who pressed it here, in
 * actions.ts's vocabulary; the node records it, with this hub's name, as the
 * actor on its own gate row.
 */
export function decideRemote(id: string, decision: "allow" | "deny", reason: string, by: string): Promise<{ ok: boolean; error?: string }> {
  const g = remoteGate(id);
  const ws = g ? live.get(g.host) : undefined;
  if (!g || !ws) return Promise.resolve({ ok: false, error: "that request is not one a linked machine is holding" });
  if (awaiting.has(id)) return Promise.resolve({ ok: false, error: "an answer to that request is already on its way" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      awaiting.delete(id);
      resolve({ ok: false, error: `${g.host} did not confirm in time — check it there` });
    }, DECIDE_MS);
    awaiting.set(id, { host: g.host, resolve, timer });
    send(ws, { t: "decide", id, decision, reason, by });
  });
}

/*
 * Phase 4: requests carried to a node and not yet answered, by request id.
 * Bounded per node — a page that opens a repository asks for a dozen things at
 * once, and a node is somebody's desk, not a server farm.
 */
export interface TunnelAnswer { status: number; type: string; body: string }
const tunnel = new Map<number, { host: string; resolve: (a: TunnelAnswer) => void; timer: ReturnType<typeof setTimeout> }>();
let nextRid = 1;
const TUNNEL_MS = 30_000;
const TUNNEL_PER_NODE = 16;

const answer = (status: number, error: string): TunnelAnswer =>
  ({ status, type: "application/json", body: JSON.stringify({ ok: false, error }) });

/**
 * Ask a node to run one read against its own router, and hand back its answer.
 *
 * The node is the one that decides whether it will (tunnelAllows in auth.ts,
 * on its side); the hub checks the same thing first only so a refusal is fast.
 * A node that is not linked, too busy, or silent gets an answer in the shape
 * every panel already reads errors in — `{ ok: false, error }` — never a hang.
 */
export function requestRemote(
  host: string, method: "GET" | "POST", path: string, query: string, body?: string,
): Promise<TunnelAnswer> {
  const ws = live.get(host);
  if (!ws) return Promise.resolve(answer(502, `${host} is not linked to this hub right now`));
  let inFlight = 0;
  for (const t of tunnel.values()) if (t.host === host) inFlight++;
  if (inFlight >= TUNNEL_PER_NODE) return Promise.resolve(answer(503, `${host} is busy answering — try again in a moment`));
  const rid = nextRid++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      tunnel.delete(rid);
      resolve(answer(504, `${host} did not answer in time`));
    }, TUNNEL_MS);
    tunnel.set(rid, { host, resolve, timer });
    send(ws, { t: "req", rid, method, path, query, ...(body !== undefined ? { body } : {}) });
  });
}

function settle(id: string, r: { ok: boolean; error?: string }): void {
  const w = awaiting.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  awaiting.delete(id);
  w.resolve(r);
}

function send(ws: Ws, f: HubFrame): void {
  try { ws.send(JSON.stringify(f)); } catch { /* closing */ }
}

function refuse(ws: Ws, error: string): void {
  console.warn(`[fleet] refused ${ws.data.host}: ${error}`);
  send(ws, { t: "refuse", error });
  try { ws.close(1008, error.slice(0, 120)); } catch { /* already gone */ }
}

export function fleetOpen(ws: Ws): void {
  ws.data.connectedAt = Date.now();
  ws.data.rows = 0;
  // A socket that never says who it is holds a slot and proves nothing.
  ws.data.helloTimer = setTimeout(() => { if (!ws.data.greeted) refuse(ws, "no hello"); }, HELLO_MS);
}

export function fleetMessage(ws: Ws, msg: string | Buffer): void {
  if (typeof msg !== "string") return refuse(ws, "binary frame");
  const parsed = parseNodeFrame(msg);
  if (!parsed.ok) return refuse(ws, parsed.error);
  const f = parsed.frame;

  if (f.t === "hello") {
    if (ws.data.greeted) return refuse(ws, "hello twice");
    if (f.host !== ws.data.host) {
      return refuse(ws, `this credential forwards as "${ws.data.host}", not "${f.host}"`);
    }
    // Checked here as well as when the credential was minted: this hub may
    // have been renamed since, and its own name arriving from outside would
    // mix another machine's rows into the ones stored as NULL — "here".
    if (f.host === hostId()) return refuse(ws, `"${f.host}" is this hub's own name`);
    clearTimeout(ws.data.helloTimer);
    const prev = live.get(f.host);
    if (prev && prev !== ws) { try { prev.close(1000, "replaced by a newer link"); } catch { /* gone */ } }
    live.set(f.host, ws);
    ws.data.greeted = true;
    ws.data.version = f.version;
    noteNode(f.host, f.version);
    send(ws, { t: "welcome", v: FLEET_PROTOCOL, host: hostId(), after: nodeCursor(f.host) });
    return;
  }

  if (!ws.data.greeted) return refuse(ws, "rows before hello");

  if (f.t === "gates") {
    const before = remoteGates.get(ws.data.host);
    const now = new Map(f.gates.map((g) => [g.id, g]));
    remoteGates.set(ws.data.host, now);
    for (const g of now.values()) {
      if (before?.has(g.id)) continue;
      try { onRemoteGate?.(ws.data.host, g); } catch (e) {
        console.error(`[fleet] gate alert failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return;
  }
  if (f.t === "res") {
    const t = tunnel.get(f.rid);
    // Only an answer to a request sent to THIS node.
    if (!t || t.host !== ws.data.host) return;
    clearTimeout(t.timer);
    tunnel.delete(f.rid);
    t.resolve({ status: f.status, type: f.type, body: f.body });
    return;
  }
  if (f.t === "decided") {
    // Only an answer this hub asked this node for. A node cannot settle a
    // decision that was sent to another machine.
    if (awaiting.get(f.id)?.host === ws.data.host) settle(f.id, { ok: f.ok, error: f.error });
    return;
  }

  let applied: AppliedBatch;
  try {
    applied = applyBatch(ws.data.host, f.upto, f.events, f.sessions);
  } catch (e) {
    // Nothing was stored (one transaction) and nothing is acked, so the node
    // resends this batch on its next connect. Closing rather than refusing:
    // a full disk or a locked database is this hub's problem, not the node's.
    console.error(`[fleet] could not store a batch from ${ws.data.host}: ${e instanceof Error ? e.message : e}`);
    try { ws.close(1011, "hub could not store the batch"); } catch { /* gone */ }
    return;
  }
  ws.data.lastBatchAt = Date.now();
  ws.data.rows = (ws.data.rows ?? 0) + applied.inserted.length;
  send(ws, { t: "ack", upto: f.upto });
  try { onForeign?.(applied); } catch (e) {
    console.error(`[fleet] live push failed: ${e instanceof Error ? e.message : e}`);
  }
}

export function fleetClose(ws: Ws): void {
  clearTimeout(ws.data.helloTimer);
  if (live.get(ws.data.host) !== ws) return; // a newer link already replaced this one
  live.delete(ws.data.host);
  // Its holds are still held over there, and still time out there; they are
  // only no longer answerable from here, so they stop being offered.
  remoteGates.delete(ws.data.host);
  for (const [id, w] of awaiting) {
    if (w.host === ws.data.host) settle(id, { ok: false, error: `${w.host} went offline before confirming — check it there` });
  }
  for (const [rid, t] of tunnel) {
    if (t.host !== ws.data.host) continue;
    clearTimeout(t.timer);
    tunnel.delete(rid);
    t.resolve(answer(502, `${t.host} went offline before answering`));
  }
}

export interface FleetNodeStatus {
  host: string;
  connected: boolean;
  /** Highest origin id stored — how far this hub has the node's history. */
  after: number;
  first_seen: number;
  last_seen: number;
  version: string | null;
  connected_at: number | null;
  last_batch_at: number | null;
  /** Rows stored over the current connection. */
  rows: number;
  ip: string | null;
}

/** Every node this hub has heard from, and whether it is linked right now. */
export function fleetNodes(): FleetNodeStatus[] {
  return fleetNodeRows().map((r) => {
    const ws = live.get(r.host);
    return {
      host: r.host,
      connected: !!ws,
      after: r.after,
      first_seen: r.first_seen,
      last_seen: ws?.data.lastBatchAt ?? r.last_seen,
      version: ws?.data.version ?? r.version,
      connected_at: ws?.data.connectedAt ?? null,
      last_batch_at: ws?.data.lastBatchAt ?? null,
      rows: ws?.data.rows ?? 0,
      ip: ws?.data.ip ?? null,
    };
  });
}
