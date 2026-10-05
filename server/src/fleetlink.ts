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
  FLEET_PROTOCOL, MAX_BATCH_BYTES, MAX_BATCH_ROWS, linkTransportOk, linkUrl, parseHubFrame, type HubFrame,
} from "./fleetwire.ts";
import { localBatch, localSessions, recentLocalSessions } from "./fleetstore.ts";

export function upstreamPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "upstream.json");
}

const IS_TEST = process.env.NODE_ENV === "test";
function offLimits(p: string): boolean {
  const scratch = tmpdir();
  return IS_TEST && p !== scratch && !p.startsWith(scratch + "/");
}

export type UpstreamConfig =
  | { ok: true; url: string; token: string; insecure: boolean; stamp: string }
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
  if (!url && !offLimits(p) && existsSync(p)) {
    try {
      const f = JSON.parse(readFileSync(p, "utf8")) as { url?: unknown; token?: unknown };
      url = typeof f.url === "string" ? f.url.trim() : "";
      token = token || (typeof f.token === "string" ? f.token.trim() : "");
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
  return { ok: true, url, token, insecure, stamp };
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
}

const status: UplinkStatus = {
  state: "off", hub: null, hubHost: null, acked: 0, sent: 0,
  connectedAt: null, lastAckAt: null, error: null, retryAt: null,
};
export function uplinkStatus(): UplinkStatus { return { ...status }; }

class Refused extends Error {}

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
  constructor(ws: WebSocket) {
    ws.addEventListener("message", (ev) => { this.queue.push(String((ev as MessageEvent).data)); this.wake(); });
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

    for (;;) {
      if (inbox.closed) throw inbox.closed;
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
