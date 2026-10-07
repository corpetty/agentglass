/**
 * The cloud intake: where Claude Code sessions running in Anthropic's cloud
 * report their hook events (docs/FLEET.md, phase 5).
 *
 * A separate listener, on purpose. A cloud session reaches this machine from
 * the internet — through Tailscale Funnel or a proxy of your choosing — and the
 * main server can open a shell, push to your repositories and drive Docker.
 * Nothing about it should be one route away from the internet. So this is its
 * own `Bun.serve` on its own port, bound to loopback for the funnel to front,
 * serving exactly one thing: `POST /cloud/ingest`, with a cloud credential.
 * Every other path is a 404 — not a 401, which would say there is something
 * here worth a credential.
 *
 * What arrives is the body hooks/cloud_hook.py builds, the same shape the local
 * forwarder sends to /ingest. It is normalized by the same code and stored
 * under the credential's host name (default `cloud`), so every guard phases
 * 1–4 put on another machine's rows applies: never in a local scope, never
 * resolved against this disk, never resumed or acted on here, no gate.
 *
 * Off unless AGENTGLASS_CLOUD_PORT is set.
 */
import type { Server } from "bun";
import type { IngestBody } from "../../shared/types.ts";
import { deviceFor, markSeen } from "./devices.ts";
import { clampIngestTimestamp, externalIngestError, normalize } from "./ingest.ts";
import { insertEvent } from "./db.ts";

/** A hook body carries the transcript at Stop; long sessions make big ones. */
const MAX_BODY = 8 * 1024 * 1024;
/** Per credential. A busy session fires a few hooks a second; a loop that
 *  fires hundreds is a bug, and this keeps it from filling the database. */
const RATE_PER_SEC = 20;
const BURST = 60;

export interface CloudIntakeStatus {
  port: number | null;
  /** Per host name: when it last reported, and how many events this run. */
  hosts: { host: string; last: number; events: number }[];
}

const seen = new Map<string, { last: number; events: number }>();
const buckets = new Map<string, { tokens: number; at: number }>();
let listening: number | null = null;
let server: Server<undefined> | null = null;

export function cloudIntakeStatus(): CloudIntakeStatus {
  return { port: listening, hosts: [...seen].map(([host, v]) => ({ host, ...v })) };
}

function allow(key: string, now: number): boolean {
  const b = buckets.get(key) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_SEC);
  b.at = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

const reply = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * One request, decided. Exported so a test can drive it without a socket.
 *
 * The answer to a stored event is `{}` and nothing else: the hook that sent it
 * prints nothing and exits 0 whatever this says, and a reporting hook must
 * never be able to steer the session it reports on.
 */
export async function handleCloudRequest(
  req: Request,
  onStored: (r: { inserted: number[]; sessions: string[] }) => void,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(req.url);
  // `/` as well as `/cloud/ingest`: a funnel mounted at a path may or may not
  // strip it on the way through, and everything this listener does is ingest.
  if ((url.pathname !== "/cloud/ingest" && url.pathname !== "/") || req.method !== "POST") return reply(404, { error: "not found" });
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const device = token ? deviceFor(token) : null;
  if (!device || device.role !== "cloud" || !device.host) return reply(401, { error: "unauthorized" });
  if (!allow(device.id, now)) return reply(429, { error: "slow down" });
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return reply(413, { error: "too large" });
  let body: IngestBody;
  try { body = (await req.json()) as IngestBody; } catch { return reply(400, { error: "invalid json" }); }
  const bad = externalIngestError(body);
  if (bad) return reply(400, { error: bad });
  // A session with no id would be stored as the hook's own fallback, which is
  // the same string from every cloud session there is. Better dropped.
  if (body.session_id === "unknown") return reply(400, { error: "session_id is required" });
  const n = normalize(body);
  n.host = device.host;
  n.timestamp = clampIngestTimestamp(n.timestamp, now);
  const result = insertEvent(n);
  markSeen(device.id, now);
  const s = seen.get(device.host) ?? { last: 0, events: 0 };
  s.last = now;
  if (result.inserted) s.events++;
  seen.set(device.host, s);
  if (result.inserted) onStored({ inserted: [result.event.id], sessions: [result.session.session_id] });
  return reply(200, {});
}

/**
 * Start listening, if configured. Loopback only: the funnel, or whatever
 * terminates TLS in front of this, is what the internet talks to.
 */
export function startCloudIntake(onStored: (r: { inserted: number[]; sessions: string[] }) => void): number | null {
  const raw = process.env.AGENTGLASS_CLOUD_PORT;
  if (!raw || server) return listening;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.warn(`[cloud] ignoring AGENTGLASS_CLOUD_PORT=${JSON.stringify(raw)}: not a port`);
    return null;
  }
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      maxRequestBodySize: MAX_BODY,
      fetch: (req) => handleCloudRequest(req, onStored),
    });
    listening = port;
    console.log(`☁  cloud intake on http://127.0.0.1:${port}/cloud/ingest — front it with Tailscale Funnel (docs/FLEET.md)`);
  } catch (e) {
    console.warn(`[cloud] could not listen on ${port}: ${e instanceof Error ? e.message : e}`);
  }
  return listening;
}
