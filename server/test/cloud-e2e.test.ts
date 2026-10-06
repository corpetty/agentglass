// A cloud session's hook, reporting to a real hub (docs/FLEET.md, phase 5).
//
// The whole chain, with nothing mocked but the internet: the shipped hook script
// (hooks/cloud_hook.py), run as Claude Code runs it in a cloud session, posting
// over HTTPS to a TLS front — standing in for Tailscale Funnel, with a
// throwaway certificate the hook is told to trust — which forwards to the hub's
// cloud intake, which stores the event under `cloud` on a hub that can then be
// asked about it like any other machine's session.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "hub-secret-for-cloud-e2e";
let root: string;
let hub: { base: string; proc: ReturnType<typeof Bun.spawn>; intake: number };
let front: ReturnType<typeof Bun.serve>;
let cloudToken = "";
let certFile = "";

const SID = "6f1e2d3c-4b5a-4987-8a7b-6c5d4e3f2a1b";
const REMOTE = "cse_01ABCDEF";

const asHub = (path: string, init: RequestInit = {}) =>
  fetch(hub.base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
const body = async (r: Promise<Response> | Response): Promise<any> => (await r).json();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agx-cloud-e2e-"));
  const dir = join(root, "hub");
  mkdirSync(dir, { recursive: true });
  const [port, intake] = [await freePort(), await freePort()];
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      AGENTGLASS_DB: join(dir, "a.db"), AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_DISPATCH_DISABLED: "1",
      AGENTGLASS_TERMINAL_DISABLED: "1", AGENTGLASS_PORT: String(port),
      AGENTGLASS_HOST_ID: "hub", AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_CLOUD_PORT: String(intake),
    },
    stdout: "ignore", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  hub = { base, proc, intake };

  // The funnel's stand-in: TLS on a certificate for 127.0.0.1, forwarding to
  // the intake exactly as tailscaled would.
  certFile = join(root, "cert.pem");
  const keyFile = join(root, "key.pem");
  const gen = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyFile, "-out", certFile, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stderr: "pipe" });
  if (gen.exitCode !== 0) throw new Error("openssl failed: " + new TextDecoder().decode(gen.stderr));
  front = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    tls: { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") },
    fetch: async (req) => {
      const u = new URL(req.url);
      return fetch(`http://127.0.0.1:${intake}${u.pathname}`, { method: req.method, headers: req.headers, body: await req.arrayBuffer() });
    },
  });
}, SERVER_BOOT_MS);

afterAll(() => {
  try { hub?.proc.kill(); } catch { /* gone */ }
  try { front?.stop(true); } catch { /* gone */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* fine */ }
});

/** Run the shipped hook as Claude Code does in a cloud session. Async on
 *  purpose: the TLS front answering it lives in this process, and a blocking
 *  spawn would leave it unable to. */
async function hook(event: Record<string, unknown>, env: Record<string, string> = {}) {
  const p = Bun.spawn(["python3", new URL("../../hooks/cloud_hook.py", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE,
      AGENTGLASS_CLOUD_URL: `https://127.0.0.1:${front.port}`,
      AGENTGLASS_CLOUD_TOKEN: cloudToken,
      SSL_CERT_FILE: certFile,
      ...env,
    },
    stdin: new TextEncoder().encode(JSON.stringify(event)),
    stdout: "pipe", stderr: "pipe",
  });
  const code = await p.exited;
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code, out };
}

describe("a cloud session reporting to the hub", () => {
  test("the hub mints a cloud credential, and its intake is listening", async () => {
    const r = await body(asHub("/fleet/clouds", { method: "POST", body: JSON.stringify({}) }));
    expect(r.ok).toBe(true);
    expect(r.device.host).toBe("cloud");
    expect(r.intake).toBe(hub.intake);
    cloudToken = r.token;
  });

  test("the shipped hook's events land under `cloud`, priced at the end of a turn", async () => {
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, [
      { type: "user", message: { role: "user", content: "fix the flaky test" } },
      { type: "assistant", message: { id: "m1", model: "claude-opus-5", role: "assistant", content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    ].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const base = { session_id: SID, cwd: "/home/user/webapp", transcript_path: transcript };
    for (const e of [
      { ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the flaky test" },
      { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { stdout: "ok" } },
      { ...base, hook_event_name: "Stop" },
    ]) {
      // Silent and successful whatever the hub said: a reporting hook steers nothing.
      expect(await hook(e)).toEqual({ code: 0, out: "" });
    }
    const s = (await body(asHub("/sessions?host=cloud"))).find((x: any) => x.session_id === SID);
    expect(s).toBeTruthy();
    expect(s.source_app).toBe("webapp");
    expect(s.event_count).toBe(3);
    expect(s.cost_usd).toBeGreaterThan(0);
  }, 30_000);

  test("its deep-dive knows the session's id on claude.ai", async () => {
    const d = await body(asHub(`/session?id=${SID}`));
    expect(d.host).toBe("cloud");
    expect(d.cloud_session).toBe(REMOTE);
  });

  test("the hub says the intake heard from it", async () => {
    const st = await body(asHub("/fleet/status"));
    expect(st.cloud.port).toBe(hub.intake);
    expect(st.cloud.hosts.find((h: any) => h.host === "cloud")?.events).toBe(3);
  });

  test("the intake and the main server each refuse the other's business", async () => {
    // The internet-facing listener serves nothing but ingest …
    expect((await fetch(`http://127.0.0.1:${hub.intake}/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    // … and the cloud credential buys nothing on the server that opens shells.
    expect((await fetch(hub.base + "/sessions", { headers: { Authorization: `Bearer ${cloudToken}` } })).status).toBe(403);
  });

  test("a revoked credential stops reporting — silently, for the session", async () => {
    const id = (await body(asHub("/fleet/nodes"))).clouds.find((c: any) => c.host === "cloud").id;
    await asHub("/pair/forget", { method: "POST", body: JSON.stringify({ id }) });
    const before = (await body(asHub("/sessions?host=cloud"))).find((x: any) => x.session_id === SID).event_count;
    expect(await hook({ session_id: SID, cwd: "/home/user/webapp", hook_event_name: "PostToolUse", tool_name: "Read" })).toEqual({ code: 0, out: "" });
    const after = (await body(asHub("/sessions?host=cloud"))).find((x: any) => x.session_id === SID).event_count;
    expect(after).toBe(before);
  }, 15_000);
});
