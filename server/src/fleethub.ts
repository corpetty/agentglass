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
import { FLEET_PROTOCOL, parseNodeFrame, type HubFrame } from "./fleetwire.ts";
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
  if (live.get(ws.data.host) === ws) live.delete(ws.data.host);
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
