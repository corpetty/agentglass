#!/usr/bin/env bun
/**
 * `bun run fleet` — join machines into one cockpit (docs/FLEET.md).
 *
 *   On the hub (the always-on box), over ssh if it is headless:
 *     bun run fleet add-node <host> [--replace]   mint a credential for one node
 *     bun run fleet nodes                         who forwards here
 *
 *   On each node:
 *     bun run fleet join <hub-url> <token> [--tunnel=read|answer|chat|off]
 *                                                 forward this machine's rows; --tunnel says
 *                                                 how much the hub may do here (default read)
 *     bun run fleet leave                         stop forwarding
 *
 *   Cloud sessions (Claude Code on the web) — on the hub:
 *     bun run fleet add-cloud [name] [--replace]  mint a credential, print the setup
 *     bun run fleet cloud-hook                    the hook script, for the repository
 *     bun run fleet cloud-settings                the .claude/settings.json hooks block
 *
 *   Either:
 *     bun run fleet status
 *
 * Every command talks to the agentglass running on THIS machine, over
 * loopback, with this machine's token — the same one the desk uses. The hub
 * mints credentials through its running server rather than by editing a file,
 * because the server ignores credential rows written behind its back
 * (devices.ts), and it should.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync as readText } from "node:fs";
import { HOST_ID_RE, linkTransportOk } from "../server/src/fleetwire.ts";

const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
const upstreamFile = () => join(configDir(), "upstream.json");
const local = () => (process.env.AGENTGLASS_SERVER || `http://127.0.0.1:${process.env.AGENTGLASS_PORT || 4000}`).replace(/\/+$/, "");

function die(msg: string): never {
  console.error(`fleet: ${msg}`);
  process.exit(1);
}

/** This machine's token: the environment first, as the server reads it, then
 *  the file a non-loopback server persists. None is fine for a reader on a
 *  tokenless loopback box; the hub refuses to mint without one anyway. */
function machineToken(): string | null {
  const env = process.env.AGENTGLASS_TOKEN?.trim();
  if (env) return env;
  const p = join(configDir(), "token");
  try { return existsSync(p) ? readFileSync(p, "utf8").trim() || null : null; } catch { return null; }
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const token = machineToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(local() + path, { ...init, headers });
  } catch {
    die(`no agentglass answering at ${local()} — is it running? (AGENTGLASS_SERVER / AGENTGLASS_PORT point elsewhere)`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 401 && !token
      ? " — no token found; if the server's token is set in its environment (a systemd unit), export AGENTGLASS_TOKEN here too"
      : "";
    die(`${path}: ${body?.error ?? res.statusText}${hint}`);
  }
  return body;
}

const ago = (t: number | null | undefined) => {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

async function addNode(args: string[]) {
  const host = args.find((a) => !a.startsWith("--"));
  if (!host || !HOST_ID_RE.test(host)) die("usage: fleet add-node <host> [--replace]   (host: letters, digits, . _ -)");
  const r = await call("/fleet/nodes", {
    method: "POST",
    body: JSON.stringify({ host, replace: args.includes("--replace") }),
  });
  const status = await call("/fleet/status");
  console.log(`Minted a node credential for "${host}" on hub "${status.host}". It is shown once — copy it now.\n`);
  console.log(`  ${r.token}\n`);
  console.log(`On ${host}, with its agentglass running:\n`);
  console.log(`  bun run fleet join <this hub's URL> ${r.token}\n`);
  console.log("The URL must be https, a Tailscale address (http://100.x.y.z:4000 or *.ts.net), or an ssh tunnel to");
  console.log("localhost — the link carries prompts and file contents, and the credential rides in its first request.");
  console.log(`\nThe node must also be named "${host}": AGENTGLASS_HOST_ID=${host}, or "hostId" in its config.json,`);
  console.log("unless that is already its short hostname. Revoke it any time from the Remote pane, or with --replace.");
}

async function nodes() {
  const r = await call("/fleet/nodes");
  if (!r.nodes.length && !r.credentials.length) {
    console.log("No nodes. Mint one with: bun run fleet add-node <host>");
    return;
  }
  const byHost = new Map<string, any>(r.nodes.map((n: any) => [n.host, n]));
  const hosts = new Set<string>([...r.credentials.map((c: any) => c.host), ...r.nodes.map((n: any) => n.host)]);
  for (const h of [...hosts].sort()) {
    const n = byHost.get(h);
    const cred = r.credentials.find((c: any) => c.host === h);
    const state = n?.connected ? "linked" : n ? `offline, last heard ${ago(n.last_seen)}` : "never connected";
    console.log(`${h.padEnd(20)} ${state}${n ? ` · ${n.after} rows deep` : ""}${cred ? "" : " · credential revoked"}`);
  }
}

async function join_(args: string[]) {
  const [hub, token] = args.filter((a) => !a.startsWith("--"));
  if (!hub || !token) die("usage: fleet join <hub-url> <token> [--tunnel=read|answer|chat|off]");
  const tunnelArg = args.find((a) => a.startsWith("--tunnel="))?.slice("--tunnel=".length);
  if (tunnelArg !== undefined && !["off", "read", "answer", "chat"].includes(tunnelArg)) {
    die("--tunnel is one of off, read, answer, chat");
  }
  let url: URL;
  try { url = new URL(hub); } catch { die(`not a URL: ${hub}`); }
  if (!linkTransportOk(url, process.env.AGENTGLASS_UPSTREAM_INSECURE === "1")) {
    die(`${url.origin} is plain HTTP off this machine and off the tailnet. Use https, a Tailscale address, or an ssh `
      + "tunnel (ssh -L 4100:localhost:4000 hub, then http://localhost:4100). AGENTGLASS_UPSTREAM_INSECURE=1 overrides.");
  }
  // Is it an agentglass at all? Its name is not on /health (that route answers
  // anyone), so a hub sharing this machine's name is caught by the link
  // itself, on its first welcome, and reported by `fleet status`.
  let health: any;
  try {
    health = await (await fetch(new URL("/health", url))).json();
  } catch {
    die(`nothing answered at ${url.origin}/health`);
  }
  if (health?.service !== "agentglass") die(`${url.origin} is not an agentglass`);
  const me = await call("/fleet/status");
  const p = upstreamFile();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({
    url: url.origin + url.pathname.replace(/\/+$/, ""), token, ...(tunnelArg ? { tunnel: tunnelArg } : {}),
  }, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* not every fs has modes */ }
  console.log(`Joined: "${me.host}" forwards to ${url.origin}.`);
  console.log("The running server picks this up within a few seconds — watch it with: bun run fleet status");
  if (tunnelArg === "answer" || tunnelArg === "chat") {
    console.log(`The hub may ${tunnelArg === "chat" ? "resume and start" : "reply to running"} sessions here once agentglass restarts:`);
    console.log("answers and turns are only taken from the hub this machine started with.");
  }
}

async function leave() {
  const p = upstreamFile();
  if (!existsSync(p)) { console.log("Not in a fleet."); return; }
  rmSync(p);
  console.log("Left the fleet. Rows already on the hub stay there until its retention prunes them;");
  console.log("revoke this machine's credential on the hub (Remote pane) to make leaving permanent.");
}

async function status() {
  const s = await call("/fleet/status");
  console.log(`This machine: ${s.host}`);
  const u = s.upstream;
  if (u.state === "off") console.log("Forwarding:   not in a fleet (bun run fleet join <hub> <token>)");
  else {
    const line = u.state === "live"
      ? `live to ${u.hubHost} (${u.hub}) · hub has everything up to row ${u.acked} · last ack ${ago(u.lastAckAt)}`
      : `${u.state}${u.hub ? ` → ${u.hub}` : ""}${u.error ? ` — ${u.error}` : ""}${u.retryAt ? ` · retrying ${new Date(u.retryAt).toLocaleTimeString()}` : ""}`;
    console.log(`Forwarding:   ${line}`);
    const gates = {
      relayed: "held tool calls here can be answered at the hub",
      restart: "not relayed yet — this machine joined its hub after it started; restart agentglass to take answers from it",
      off: "not relayed (AGENTGLASS_UPSTREAM_GATES=0, or \"gates\": false in upstream.json)",
    }[u.gates as string] ?? u.gates;
    if (u.state === "live") console.log(`Gates:        ${gates}`);
    if (u.state === "live") {
      const tiers: Record<string, string> = {
        off: "closed to the hub",
        read: "the hub can read this machine's repositories (git, read-only)",
        answer: "the hub can read repositories and reply to sessions running here",
        chat: "the hub can read repositories, and resume or start sessions here",
      };
      console.log(`Workspace:    ${tiers[u.tunnel] ?? u.tunnel}${u.tunnelPending ? ` — "${u.tunnelPending}" after a restart` : ""}`);
    }
  }
  if (s.cloud?.port || s.cloud?.hosts?.length) {
    const hosts = (s.cloud.hosts ?? []).map((h: any) => `${h.host} (last ${ago(h.last)}, ${h.events} events this run)`).join(", ");
    console.log(`Cloud intake: ${s.cloud.port ? `listening on 127.0.0.1:${s.cloud.port}` : "not listening (AGENTGLASS_CLOUD_PORT)"}${hosts ? ` · ${hosts}` : ""}`);
  }
  if (s.nodes.length) {
    console.log("Nodes:");
    for (const n of s.nodes) {
      console.log(`  ${n.host.padEnd(18)} ${n.connected ? "linked" : `offline, last heard ${ago(n.last_seen)}`} · ${n.after} rows deep`);
    }
  }
}

/** Where the hook goes in the repository a cloud session works on. */
const CLOUD_HOOK_PATH = ".claude/hooks/agentglass_cloud.py";
const CLOUD_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "SessionEnd"];

/** The hooks block for the repository's .claude/settings.json. Every event the
 *  dashboard draws, each running the one script, which sends nothing unless it
 *  is in a cloud session with the hub's URL and token in its environment. */
function cloudSettings(): string {
  const hook = [{ type: "command", command: `python3 "$CLAUDE_PROJECT_DIR/${CLOUD_HOOK_PATH}"`, timeout: 10 }];
  const hooks: Record<string, unknown[]> = {};
  for (const e of CLOUD_EVENTS) {
    hooks[e] = [e === "PreToolUse" || e === "PostToolUse" ? { matcher: "*", hooks: hook } : { hooks: hook }];
  }
  return JSON.stringify({ hooks }, null, 2);
}

function cloudHook(): string {
  return readText(new URL("../hooks/cloud_hook.py", import.meta.url).pathname, "utf8");
}

async function addCloud(args: string[]) {
  const name = args.find((a) => !a.startsWith("--")) ?? "cloud";
  const r = await call("/fleet/clouds", { method: "POST", body: JSON.stringify({ name, replace: args.includes("--replace") }) });
  const port: number | null = r.intake ?? null;
  console.log(`Minted a cloud credential; sessions that use it are stored as host "${name}". Shown once — copy it now.\n`);
  console.log(`  ${r.token}\n`);
  console.log("Setup, once:\n");
  console.log(`1. This hub needs its cloud intake listening: set AGENTGLASS_CLOUD_PORT (e.g. 4010) and restart.`);
  console.log(`   ${port ? `It is listening on 127.0.0.1:${port} now.` : "It is NOT listening yet."}`);
  console.log(`2. Put the intake — and only the intake — on the internet with Tailscale Funnel:`);
  console.log(`     tailscale funnel --bg --set-path /cloud/ingest http://127.0.0.1:${port ?? 4010}`);
  console.log(`   Never funnel the main server's port: it opens shells.`);
  console.log(`3. In the repository the cloud sessions work on, commit the hook and its settings:`);
  console.log(`     bun run fleet cloud-hook > <repo>/${CLOUD_HOOK_PATH}`);
  console.log(`     bun run fleet cloud-settings     # merge into <repo>/.claude/settings.json`);
  console.log(`   Safe to commit: outside a cloud session, or without the two variables below, it sends nothing.`);
  console.log(`4. In the cloud environment's settings on claude.ai (Environments → yours):`);
  console.log(`     AGENTGLASS_CLOUD_URL=https://<this hub's funnel name>.ts.net`);
  console.log(`     AGENTGLASS_CLOUD_TOKEN=${r.token}`);
  console.log(`   and set its network access to Custom with your funnel hostname allowed (or Full) —`);
  console.log(`   the default "Trusted" level cannot reach it.\n`);
  console.log("What arrives: live tool calls, prompts and replies; cost when a turn ends. Not available for");
  console.log("cloud sessions: history from before the hook, holds you can approve, or the workspace panels.");
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "add-node": await addNode(rest); break;
  case "nodes": await nodes(); break;
  case "join": await join_(rest); break;
  case "leave": await leave(); break;
  case "add-cloud": await addCloud(rest); break;
  case "cloud-hook": process.stdout.write(cloudHook()); break;
  case "cloud-settings": console.log(cloudSettings()); break;
  case "status": case undefined: await status(); break;
  default: die(`unknown command "${cmd}" — add-node, nodes, join, leave, add-cloud, cloud-hook, cloud-settings, status`);
}
