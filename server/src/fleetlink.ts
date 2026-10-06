/**
 * The node end of the fleet link: forward this machine's rows to a hub.
 *
 * Off unless configured. `bun run fleet join <hub> <token>` writes
 * `~/.config/agentglass/upstream.json` (0600); AGENTGLASS_UPSTREAM_URL and
 * AGENTGLASS_UPSTREAM_TOKEN override it. The file is re-read when it changes,
 * so joining or leaving a fleet does not need a restart.
 *
 * One socket, one batch in flight. The hub says where this node got to on
 * every connect (`welcome.after`), the node sends what comes after it in
 * bounded batches and waits for each ack before the next. Nothing is
 * remembered here between connections — a node that sleeps for a night asks
 * on waking and backfills the gap, and one whose hub lost its database simply
 * starts again from the beginning of what it still has.
 *
 * Forwarding never touches local behaviour. Gates are still held here, the
 * hooks still post to 127.0.0.1, the cockpit on this machine is unchanged —
 * a hub that is down, unreachable or refusing costs a log line and a retry.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostId } from "./config.ts";
import {
  FLEET_PROTOCOL, MAX_BATCH_BYTES, MAX_BATCH_ROWS, MAX_GATES, MAX_TUNNEL_RESPONSE, linkTransportOk, linkUrl, parseHubFrame, type HubFrame,
} from "./fleetwire.ts";
import { localBatch, localSessions, recentLocalSessions } from "./fleetstore.ts";
import { heldGates, decideGate, watchGates } from "./gate.ts";
import { isMachineActor, MACHINE_ACTOR } from "./actions.ts";
import { tunnelAllows } from "./auth.ts";

export function upstreamPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "upstream.json");
}

const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

export type UpstreamConfig =
  | { ok: true; url: string; token: string; insecure: boolean; stamp: string; gates: boolean; tunnel: boolean }
  | { ok: false; error: string; stamp: string };

function stampOf(p: string): string {
  try { const st = statSync(p); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return "none"; }
}

/**
 * What to forward to, or null when this machine is not in a fleet.
 *
 * A config that is present but unusable — bad JSON, a URL that would send the
 * credential in the clear — is reported rather than ignored, so `fleet status`
 * can say why nothing is happening instead of showing a link that is merely off.
 */
/** What upstreamConfig() would be keyed on, from a stat and the environment
 *  alone — asked every second by an idle link, so it never reads the file. */
function upstreamStamp(): string {
  return `env:${process.env.AGENTGLASS_UPSTREAM_URL ?? ""}|${stampOf(upstreamPath())}`;
}

export function upstreamConfig(): UpstreamConfig | null {
  const insecure = process.env.AGENTGLASS_UPSTREAM_INSECURE === "1";
  const p = upstreamPath();
  const stamp = upstreamStamp();
  let url = process.env.AGENTGLASS_UPSTREAM_URL?.trim() || "";
  let token = process.env.AGENTGLASS_UPSTREAM_TOKEN?.trim() || "";
  let gates = process.env.AGENTGLASS_UPSTREAM_GATES !== "0";
  let tunnel = process.env.AGENTGLASS_UPSTREAM_TUNNEL !== "off";
  if (!url && !offLimits(p) && existsSync(p)) {
    try {
      const f = JSON.parse(readFileSync(p, "utf8")) as { url?: unknown; token?: unknown; gates?: unknown; tunnel?: unknown };
      url = typeof f.url === "string" ? f.url.trim() : "";
      token = token || (typeof f.token === "string" ? f.token.trim() : "");
      if (f.gates === false) gates = false;
      if (f.tunnel === "off" || f.tunnel === false) tunnel = false;
    } catch (e) {
      return { ok: false, error: `${p}: ${e instanceof Error ? e.message : e}`, stamp };
    }
  }
  if (!url) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, error: `not a URL: ${url}`, stamp }; }
  if (!linkTransportOk(parsed, insecure)) {
    return {
      ok: false,
      error: `${parsed.origin} is plain HTTP off this machine and off the tailnet — the link carries prompts and its own `
        + "credential, so it needs https, an ssh tunnel to localhost, or a Tailscale address (AGENTGLASS_UPSTREAM_INSECURE=1 overrides)",
      stamp,
    };
  }
  if (!token) return { ok: false, error: "no token — run `bun run fleet join <hub> <token>`", stamp };
  return { ok: true, url, token, insecure, stamp, gates, tunnel };
}

/*
 * The hub this process will take gate answers from: the one it was configured
 * with when it STARTED, and only that one.
 *
 * Forwarding rows to a hub is harmless to get wrong; taking answers from one is
 * not. An answer releases a held tool call on this machine, and the party being
 * held is an agent running as this user — which can write upstream.json as
 * easily as anything else here. If a config written at runtime were trusted for
 * answers, an agent could point it at a "hub" of its own on localhost and wave
 * its own calls through, which is the one thing a gate exists to prevent (see
 * mayReleaseAHold in index.ts). So a change made while running still moves the
 * rows — joining a fleet needs no restart — but answers wait for one. The same
 * line devices.json draws, for the same reason, with the same ceiling: a
 * process that can edit the file and wait for a restart can also replace this
 * server's code, and nothing here defends against that (SECURITY.md).
 */
let pinned: { url: string; token: string } | null = null;
function gatesRelayed(cfg: Extract<UpstreamConfig, { ok: true }>): boolean {
  return cfg.gates && !!pinned && pinned.url === cfg.url && pinned.token === cfg.token;
}

export interface UplinkStatus {
  state: "off" | "misconfigured" | "connecting" | "live" | "backoff" | "refused";
  hub: string | null;
  hubHost: string | null;
  /** The hub's cursor as last acknowledged: everything up to this id is there. */
  acked: number;
  /** Events forwarded over the current connection. */
  sent: number;
  connectedAt: number | null;
  lastAckAt: number | null;
  error: string | null;
  retryAt: number | null;
  /**
   * Whether this machine's held tool calls go to the hub to be answered there.
   * `restart` means the hub was joined after this process started, so answers
   * from it are not taken until it restarts (see `pinned`).
   */
  gates: "relayed" | "off" | "restart";
  /** Whether the hub may read this machine's workspace (git, files) through
   *  the link — read-only, by tunnelAllows' ceiling (phase 4). */
  tunnel: "read" | "off";
}

const status: UplinkStatus = {
  state: "off", hub: null, hubHost: null, acked: 0, sent: 0,
  connectedAt: null, lastAckAt: null, error: null, retryAt: null, gates: "off", tunnel: "off",
};
export function uplinkStatus(): UplinkStatus { return { ...status }; }

class Refused extends Error {}

/*
 * Who runs a tunnelled request: this server's own router (index.ts sets it).
 * A hook rather than an import, because the router is index.ts and this module
 * is one of the things index.ts imports.
 */
let dispatch: ((req: Request) => Promise<Response>) | null = null;
export function setTunnelDispatch(fn: ((req: Request) => Promise<Response>) | null): void { dispatch = fn; }

const tunnelAnswer = (status: number, error: string) =>
  ({ status, type: "application/json", body: JSON.stringify({ ok: false, error }) });

/**
 * Run one request the hub carried here, and say what this machine answered.
 *
 * The ceiling is checked HERE, by this machine, whatever the hub decided:
 * tunnelAllows is the boundary, and a hub that is wrong, out of date or not
 * ours asks for nothing beyond it. The request is rebuilt from the path and
 * nothing else — none of the hub's headers, no Origin, no credential of its
 * own — and handed to this server's router as a call from this machine, which
 * is what puts this machine's own scope and repository checks in charge.
 */
async function runTunnelled(f: Extract<HubFrame, { t: "req" }>, allowed: boolean) {
  if (!allowed) return tunnelAnswer(403, `${hostId()} does not open its workspace to its hub`);
  if (!tunnelAllows(f.method, f.path)) {
    return tunnelAnswer(403, `${f.method} ${f.path} is not something ${hostId()} reads for its hub — the fleet link is read-only`);
  }
  if (!dispatch) return tunnelAnswer(503, "this machine's server is not ready");
  try {
    const url = `http://127.0.0.1${f.path}${f.query ? `?${f.query}` : ""}`;
    const res = await dispatch(new Request(url, {
      method: f.method,
      headers: f.body !== undefined ? { "content-type": "application/json" } : {},
      ...(f.body !== undefined ? { body: f.body } : {}),
    }));
    const body = await res.text();
    if (body.length > MAX_TUNNEL_RESPONSE) {
      return tunnelAnswer(413, `that answer is ${Math.round(body.length / 1024)} KB — too large to send over the fleet link`);
    }
    return { status: res.status, type: (res.headers.get("content-type") || "application/json").slice(0, 200), body };
  } catch (e) {
    return tunnelAnswer(500, `${hostId()} could not answer: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Why a socket closed, in words a person can act on — and whether retrying
 * soon could help. Measured against Bun's client: a hub that is down closes
 * 1006 "Failed to connect"; a credential the hub turned away on the handshake
 * (401/403, never upgraded) closes 1002 "Expected 101 status code"; a hub that
 * cut a live link on purpose — a Forget in its Remote pane, a refusal — closes
 * 1008. Only the first is worth retrying within the minute.
 */
function closeReason(code: number, reason: string, opened: boolean): Error {
  if (code === 1002 && !opened) {
    return new Refused("the hub turned this node's credential away — revoked, or minted for another name; "
      + "mint a new one on the hub with `bun run fleet add-node <host> --replace`");
  }
  if (code === 1008) return new Refused(`the hub closed the link: ${reason || "policy"}`);
  if (code === 1006 && !opened) return new Error(`could not reach the hub (${reason || "connection failed"})`);
  return new Error(`link closed ${code}${reason ? ` (${reason})` : ""}`);
}

/** Messages off one socket, awaited one at a time. */
class Inbox {
  private queue: string[] = [];
  private waiter: (() => void) | null = null;
  closed: Error | null = null;
  /** A `decide` is handled the moment it lands — it may arrive while a batch
   *  is waiting for its ack, and queueing it behind the ack would read as the
   *  hub acknowledging something else. */
  onDecide: ((f: Extract<HubFrame, { t: "decide" }>) => void) | null = null;
  /** Same for a tunnelled request: answered whenever it lands, concurrently. */
  onRequest: ((f: Extract<HubFrame, { t: "req" }>) => void) | null = null;
  /** Set by the loop when the gate queue moved, so an idle wait ends now. */
  poke(): void { this.wake(); }
  constructor(ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const raw = String((ev as MessageEvent).data);
      const f = raw.includes('"decide"') || raw.includes('"req"') ? parseHubFrame(raw) : null;
      if (f?.t === "decide") { this.onDecide?.(f); return; }
      if (f?.t === "req") { this.onRequest?.(f); return; }
      this.queue.push(raw);
      this.wake();
    });
    ws.addEventListener("close", (ev) => {
      const c = ev as CloseEvent;
      this.closed = closeReason(c.code, c.reason, true);
      this.wake();
    });
  }
  private wake(): void { const w = this.waiter; this.waiter = null; w?.(); }
  /** Resolve after `ms`, or sooner if a frame arrives or the socket closes. */
  wait(ms: number): Promise<void> {
    if (this.queue.length || this.closed) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(() => { this.waiter = null; res(); }, ms);
      this.waiter = () => { clearTimeout(t); res(); };
    });
  }
  async next(ms: number): Promise<HubFrame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const raw = this.queue.shift();
      if (raw !== undefined) {
        const f = parseHubFrame(raw);
        if (!f) throw new Error("unreadable frame from hub");
        if (f.t === "refuse") throw new Refused(f.error);
        return f;
      }
      if (this.closed) throw this.closed;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("hub did not answer in time");
      await this.wait(left);
    }
  }
  /** A frame that arrived unasked — only a refusal is meaningful then. */
  pending(): boolean { return this.queue.length > 0; }
}

const IDLE_MS = 1000;
const ANSWER_MS = 30_000;
const RESYNC_MS = 60_000;
const RESYNC_WINDOW_MS = 24 * 3600_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const REFUSED_MS = 5 * 60_000;
const OFF_POLL_MS = 10_000;
/** Packed under the hub's ceiling, with room for the frame's own JSON. */
const PACK_BYTES = MAX_BATCH_BYTES - 256 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sleep, but wake early when the config file changes — joining a fleet should
 *  not wait out a five-minute refusal backoff. */
async function nap(ms: number, stamp: string | null): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(Math.min(1000, until - Date.now()));
    if (stamp !== null && upstreamStamp() !== stamp) return;
  }
}

async function runOnce(cfg: Extract<UpstreamConfig, { ok: true }>, version: string | undefined): Promise<void> {
  status.state = "connecting";
  status.hub = new URL(cfg.url).origin;
  const ws = new WebSocket(linkUrl(cfg.url).href, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  } as unknown as string[]);
  const inbox = new Inbox(ws);
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("hub did not accept the connection in time")), ANSWER_MS);
      ws.addEventListener("open", () => { clearTimeout(t); res(); });
      ws.addEventListener("close", (ev) => {
        clearTimeout(t);
        const c = ev as CloseEvent;
        rej(closeReason(c.code, c.reason, false));
      });
    });
    ws.send(JSON.stringify({ t: "hello", v: FLEET_PROTOCOL, host: hostId(), version }));
    const hello = await inbox.next(ANSWER_MS);
    if (hello.t !== "welcome") throw new Error(`expected welcome, got ${hello.t}`);
    if (hello.host === hostId()) throw new Refused(`the hub is also called "${hello.host}" — rename one (AGENTGLASS_HOST_ID)`);
    status.state = "live";
    status.hubHost = hello.host;
    status.acked = hello.after;
    status.sent = 0;
    status.connectedAt = Date.now();
    status.error = null;
    status.retryAt = null;
    let cursor = hello.after;
    let lastResync = 0;

    // Phase 3: this machine's holds, offered to the hub to be answered there.
    const relay = gatesRelayed(cfg);
    status.gates = relay ? "relayed" : cfg.gates ? "restart" : "off";
    let forwarded = new Set<string>();
    let gatesDirty = relay;
    const unwatch = relay ? watchGates(() => { gatesDirty = true; inbox.poke(); }) : () => {};
    inbox.onDecide = (f) => {
      const answer = (ok: boolean, error?: string) =>
        ws.send(JSON.stringify({ t: "decided", id: f.id, ok, ...(error ? { error } : {}) }));
      if (!relay) return answer(false, "this machine does not take gate answers from its hub");
      // Only a hold this machine actually offered. A hub cannot release a call
      // it was never shown — including one held after the last snapshot left.
      if (!forwarded.has(f.id)) return answer(false, "that is not a request this machine forwarded");
      // Who pressed it, and where. The machine-token form is kept when that is
      // what pressed it at the hub, so the model on this end is told nobody
      // reviewed the call rather than that a person did (gate.ts defaultReason).
      const where = `via ${status.hubHost ?? "the hub"}`;
      const by = isMachineActor(f.by) ? `${MACHINE_ACTOR} · ${where}` : `${f.by || "a person"} ${where}`;
      const ok = decideGate(f.id, f.decision, f.reason, by);
      answer(ok, ok ? undefined : "already resolved here — it timed out, or was answered at this machine");
    };
    status.tunnel = cfg.tunnel ? "read" : "off";
    inbox.onRequest = (f) => {
      void runTunnelled(f, cfg.tunnel).then((a) => {
        try { ws.send(JSON.stringify({ t: "res", rid: f.rid, ...a })); } catch { /* link gone; the hub times it out */ }
      });
    };
    try {
    for (;;) {
      if (inbox.closed) throw inbox.closed;
      if (gatesDirty) {
        gatesDirty = false;
        const gates = heldGates().slice(0, MAX_GATES);
        forwarded = new Set(gates.map((g) => g.id));
        ws.send(JSON.stringify({ t: "gates", gates }));
      }
      if (inbox.pending()) await inbox.next(0); // an unasked refusal throws here
      if (upstreamStamp() !== cfg.stamp) { ws.close(1000, "config changed"); return; }
      const batch = localBatch(cursor, MAX_BATCH_ROWS, PACK_BYTES);
      let sessions = batch.events.length ? localSessions([...new Set(batch.events.map((e) => String(e.session_id)))]) : [];
      const now = Date.now();
      if (!batch.events.length && now - lastResync >= RESYNC_MS) {
        sessions = recentLocalSessions(now - RESYNC_WINDOW_MS);
        lastResync = now;
      }
      if (!batch.events.length && !sessions.length && batch.upto === cursor) {
        await inbox.wait(IDLE_MS);
        continue;
      }
      ws.send(JSON.stringify({ t: "rows", upto: batch.upto, events: batch.events, sessions }));
      const ack = await inbox.next(ANSWER_MS);
      if (ack.t !== "ack" || ack.upto !== batch.upto) throw new Error("hub acknowledged something else");
      cursor = batch.upto;
      status.acked = cursor;
      status.sent += batch.events.length;
      status.lastAckAt = Date.now();
    }
    } finally {
      unwatch();
      inbox.onDecide = null;
      inbox.onRequest = null;
    }
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

let started = false;

/**
 * Start forwarding, if and when this machine is configured to. Idempotent;
 * runs for the life of the process and never throws.
 */
export function startUplink(opts: { version?: string } = {}): void {
  if (started) return;
  started = true;
  const atStart = upstreamConfig();
  pinned = atStart?.ok ? { url: atStart.url, token: atStart.token } : null;
  void (async () => {
    let backoff = BACKOFF_MIN_MS;
    let told = "";
    for (;;) {
      const cfg = upstreamConfig();
      if (!cfg || !cfg.ok) {
        status.state = cfg ? "misconfigured" : "off";
        status.error = cfg && !cfg.ok ? cfg.error : null;
        status.hub = null;
        if (status.error && status.error !== told) { console.warn(`[fleet] uplink: ${status.error}`); told = status.error; }
        await nap(OFF_POLL_MS, cfg?.stamp ?? upstreamStamp());
        continue;
      }
      let wait = backoff;
      try {
        await runOnce(cfg, opts.version);
        backoff = BACKOFF_MIN_MS;
        wait = 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Reset after a link that worked: the backoff is for a hub that is
        // down, not a penalty carried into the next healthy connection.
        if (status.state === "live") backoff = BACKOFF_MIN_MS;
        status.error = msg;
        if (e instanceof Refused) {
          status.state = "refused";
          wait = REFUSED_MS;
        } else {
          status.state = "backoff";
          wait = backoff;
          backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
        }
        if (msg !== told) { console.warn(`[fleet] uplink to ${status.hub}: ${msg}`); told = msg; }
      }
      status.retryAt = wait ? Date.now() + wait : null;
      await nap(wait, cfg.stamp);
    }
  })();
}
