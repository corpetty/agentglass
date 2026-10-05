/**
 * The fleet link's tables and the two sides' reads and writes (docs/FLEET.md).
 *
 * Kept out of db.ts so the seam there stays two readers wide. db.ts owns what
 * an event and a session ARE; this file owns how another machine's copies of
 * them get in, and how this machine's own get read out to be forwarded.
 *
 * The hub never runs a forwarded row through insertEvent. That path computes —
 * token deltas from cumulative usage, cost from the local price table, latency
 * by pairing a Post with its Pre, the session rollup — and every one of those
 * was already computed, correctly, on the machine that saw the session. Doing
 * it twice is not a cross-check, it is a second answer that can disagree with
 * the first. So rows are stored as sent, and sessions are mirrored as sent.
 */
import { db, ftsText, invalidateOpenTools } from "./db.ts";
import { EVENT_COLUMNS, SESSION_COLUMNS, type WireEvent, type WireSession } from "./fleetwire.ts";

/*
 * `origin_id` is the forwarded row's id on the machine it came from, and the
 * hub's idempotency key: (host, origin_id) is unique, so a batch the node sends
 * twice — it never heard the ack before the socket dropped — lands once.
 * NULL on every row recorded here, which the partial index skips.
 */
try { db.exec("ALTER TABLE events ADD COLUMN origin_id INTEGER"); } catch { /* already present */ }
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_origin
         ON events(host, origin_id) WHERE host IS NOT NULL AND origin_id IS NOT NULL`);

/*
 * One row per node this hub has ever heard from. `after` is the cursor — the
 * highest origin id stored for that host — and it is the only copy of it: the
 * node asks for it on every connect instead of remembering its own, so the two
 * cannot drift apart. Written in the same transaction as the rows it covers.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS fleet_nodes (
  host TEXT PRIMARY KEY,
  after INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  version TEXT
)`);

export interface FleetNodeRow {
  host: string;
  after: number;
  first_seen: number;
  last_seen: number;
  version: string | null;
}

const nodeRow = db.query<FleetNodeRow, [string]>("SELECT * FROM fleet_nodes WHERE host = ?");
const nodeRows = db.query<FleetNodeRow, []>("SELECT * FROM fleet_nodes ORDER BY host");
const nodeSeen = db.query(`
  INSERT INTO fleet_nodes (host, after, first_seen, last_seen, version)
  VALUES ($host, 0, $now, $now, $version)
  ON CONFLICT(host) DO UPDATE SET last_seen = $now, version = COALESCE($version, fleet_nodes.version)`);
const nodeAdvance = db.query(`UPDATE fleet_nodes SET after = MAX(after, $upto), last_seen = $now WHERE host = $host`);

/** Where this node got to, as far as this hub has stored. 0 for a stranger. */
export function nodeCursor(host: string): number {
  return nodeRow.get(host)?.after ?? 0;
}

/** Note a node said hello, so the cursor row exists before its first batch. */
export function noteNode(host: string, version: string | undefined, now = Date.now()): void {
  nodeSeen.run({ $host: host, $now: now, $version: version ?? null });
}

export function fleetNodeRows(): FleetNodeRow[] {
  return nodeRows.all();
}

// ---------------------------------------------------------------------------
// Hub side: storing a batch
// ---------------------------------------------------------------------------

const sessionHost = db.query<{ host: string | null }, [string]>("SELECT host FROM sessions WHERE session_id = ?");

/**
 * The session id this host's session is stored under here.
 *
 * Claude's session ids are UUIDs and pass through untouched. The ones that are
 * not — the hook's `"unknown"` fallback, OTLP's `"otel-session"` — are the same
 * string on every machine, and `sessions.session_id` is still the key: let the
 * desk's "unknown" and the box's "unknown" meet and one would overwrite the
 * other. So an id already held by a different host (this one's rows are NULL)
 * is stored as `host:id`. Stable without a table: once `box:unknown` exists,
 * `unknown` still belongs to someone else, so the next batch maps it the same.
 */
function storedSessionId(host: string, sid: string): string {
  const held = sessionHost.get(sid);
  if (!held || held.host === host) return sid;
  return `${host}:${sid}`;
}

const EVENT_INSERT = db.query(`
  INSERT OR IGNORE INTO events (${EVENT_COLUMNS.join(", ")}, host, origin_id)
  VALUES (${EVENT_COLUMNS.map((c) => `$${c}`).join(", ")}, $host, $origin_id)
  RETURNING id`);
const ftsInsert = db.query("INSERT INTO events_fts(rowid, text) VALUES ($id, $text)");

/*
 * Mirrored, never summed: every column is the node's. The WHERE on the update
 * is the last guard against writing over a session this host does not own —
 * storedSessionId has already steered around any such id, so it should never
 * fire, and if it does the row is left alone rather than taken over.
 * `pricing_baseline_usd` is local pricing state for insertEvent's cumulative
 * path, which never runs for a forwarded session; it is written 0 and stays so.
 */
const SESSION_UPSERT = db.query(`
  INSERT INTO sessions (${SESSION_COLUMNS.join(", ")}, host, pricing_baseline_usd)
  VALUES (${SESSION_COLUMNS.map((c) => `$${c}`).join(", ")}, $host, 0)
  ON CONFLICT(session_id) DO UPDATE SET
    ${SESSION_COLUMNS.filter((c) => c !== "session_id").map((c) => `${c} = excluded.${c}`).join(",\n    ")}
  WHERE sessions.host = excluded.host`);

const bind = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[`$${k}`] = v ?? null;
  return out;
};

export interface AppliedBatch {
  /** Ids (on this hub) of the events that were new. A retried batch has none. */
  inserted: number[];
  /** Session ids as stored here, for every session the batch touched. */
  sessions: string[];
}

/**
 * Store one batch from `host` and advance its cursor — all or nothing.
 *
 * Sessions first, so a brand-new session's id mapping is settled before the
 * events that name it are written. One transaction, so a crash between the
 * rows and the cursor cannot leave the cursor ahead of what landed (which
 * would lose those rows for good) — behind is harmless, the index absorbs it.
 */
export function applyBatch(
  host: string, upto: number, events: WireEvent[], sessions: WireSession[], now = Date.now(),
): AppliedBatch {
  return db.transaction((): AppliedBatch => {
    const ids = new Map<string, string>();
    const mapped = (sid: string): string => {
      let m = ids.get(sid);
      if (m === undefined) { m = storedSessionId(host, sid); ids.set(sid, m); }
      return m;
    };
    const touched = new Set<string>();
    for (const s of sessions) {
      const sid = mapped(String(s.session_id));
      SESSION_UPSERT.run(bind({ ...s, session_id: sid, host }) as any);
      touched.add(sid);
    }
    const inserted: number[] = [];
    let toolEdge = false;
    for (const e of events) {
      const sid = mapped(String(e.session_id));
      const row = EVENT_INSERT.get(bind({ ...e, session_id: sid, host }) as any) as { id: number } | null;
      touched.add(sid);
      if (!row) continue; // already stored — a retried batch
      inserted.push(row.id);
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(String(e.payload ?? "{}")); } catch { /* cleanEvent already refused these */ }
      try {
        ftsInsert.run({
          $id: row.id,
          $text: ftsText({
            source_app: String(e.source_app), session_id: sid, hook_event_type: String(e.hook_event_type),
            tool_name: (e.tool_name as string | null) ?? null, error_text: (e.error_text as string | null) ?? null, payload,
          }),
        });
      } catch { /* search is best-effort, as it is for local rows */ }
      const t = String(e.hook_event_type);
      if (t === "PreToolUse" || t === "PostToolUse" || t === "PostToolUseFailure") toolEdge = true;
    }
    nodeAdvance.run({ $host: host, $upto: upto, $now: now });
    if (toolEdge) invalidateOpenTools();
    return { inserted, sessions: [...touched] };
  })();
}

// ---------------------------------------------------------------------------
// Node side: reading what to forward
// ---------------------------------------------------------------------------

const localAfter = db.query<Record<string, unknown> & { id: number; host: string | null }, [number, number]>(
  `SELECT id, host, ${EVENT_COLUMNS.join(", ")} FROM events WHERE id > ? ORDER BY id LIMIT ?`);

/**
 * The next batch of this machine's own rows after `after`, packed to the
 * limits, and the cursor that batch covers.
 *
 * `upto` is the last id *looked at*, not the last one sent: a row that is not
 * this machine's (this instance is also somebody's hub) is skipped, and the
 * cursor still has to move past it or the node would ask for it forever.
 * Forwarding is one hop — a node never relays rows it was itself sent, which
 * keeps a loop of two machines pointed at each other from echoing for ever.
 */
export function localBatch(after: number, maxRows: number, maxBytes: number): { upto: number; events: WireEvent[] } {
  const rows = localAfter.all(after, maxRows);
  const events: WireEvent[] = [];
  let upto = after;
  let bytes = 0;
  for (const r of rows) {
    const size = String(r.payload ?? "").length + 512;
    // Always at least one row, or a single oversized row would stall the link.
    if (events.length && bytes + size > maxBytes) break;
    upto = r.id;
    if (r.host !== null) continue;
    bytes += size;
    const e: WireEvent = { origin_id: r.id };
    for (const c of EVENT_COLUMNS) e[c] = (r[c] as string | number | null) ?? null;
    events.push(e);
  }
  return { upto, events };
}

const sessionsIn = (n: number) =>
  db.query<Record<string, unknown>, string[]>(
    `SELECT ${SESSION_COLUMNS.join(", ")} FROM sessions WHERE host IS NULL AND session_id IN (${Array(n).fill("?").join(",")})`);
const recentSessions = db.query<Record<string, unknown>, [number]>(
  `SELECT ${SESSION_COLUMNS.join(", ")} FROM sessions WHERE host IS NULL AND last_seen >= ? ORDER BY last_seen DESC LIMIT 500`);

const toWire = (r: Record<string, unknown>): WireSession => {
  const s: WireSession = {};
  for (const c of SESSION_COLUMNS) s[c] = (r[c] as string | number | null) ?? null;
  return s;
};

/** This machine's session rows for these ids — sent with every batch that
 *  touches them, so the hub's mirror moves with the events. */
export function localSessions(ids: string[]): WireSession[] {
  if (!ids.length) return [];
  return sessionsIn(ids.length).all(...ids).map(toWire);
}

/**
 * Sessions seen since `since`, for the periodic resync.
 *
 * A session can change without an event: a rename by hand, the AI title
 * arriving from the transcript after the turn that produced it. The batch path
 * never sees those, so the node re-sends recently active sessions on a slow
 * timer. Bounded to recent ones on purpose — a rename of last month's session
 * reaches the hub on that session's next event, not before.
 */
export function recentLocalSessions(since: number): WireSession[] {
  return recentSessions.all(since).map(toWire);
}
