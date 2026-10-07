// The cloud intake and the hook that feeds it (docs/FLEET.md, phase 5).
//
// The intake is the one listener in this app meant to face the internet, so the
// properties under test are refusals: one route and only one, only a cloud
// credential, a reply that can steer nothing. And the hook is meant to be
// committed to a repository other people clone, so its property is silence:
// outside a cloud session, or without its two settings, it sends nothing.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratch, scratchDir } from "./scratch.ts";

const dir = scratchDir(join(tmpdir(), "agx-cloud-"));
process.env.AGENTGLASS_DB ||= join(dir, "cloud.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_HOST_ID = "hub";

let intake: typeof import("../src/cloudintake.ts");
let db: typeof import("../src/db.ts");
let token = "";
let nodeToken = "";
const stored: { inserted: number[]; sessions: string[] }[] = [];

const SID = "0d6b7f1e-6a33-4c1e-9b9e-2f3c4d5e6f70";
const post = (body: unknown, auth = `Bearer ${token}`, path = "/cloud/ingest", method = "POST") =>
  intake.handleCloudRequest(new Request(`http://127.0.0.1${path}`, {
    method, headers: { "content-type": "application/json", authorization: auth },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  }), (r) => stored.push(r));
const event = (over: Record<string, unknown> = {}) => ({
  source_app: "webapp", session_id: SID, hook_event_type: "PostToolUse",
  payload: { tool_name: "Bash", cwd: "/home/user/webapp", tool_input: { command: "npm test" } }, ...over,
});

beforeAll(async () => {
  const devices = await import("../src/devices.ts");
  token = devices.issueDevice("cloud sessions", "read", Date.now(), { host: "cloud", role: "cloud" }).token;
  nodeToken = devices.issueDevice("agentglass on bean", "read", Date.now(), { host: "bean" }).token;
  intake = await import("../src/cloudintake.ts");
  db = await import("../src/db.ts");
});

describe("the intake", () => {
  test("stores an event under the credential's host, and answers with nothing", async () => {
    const r = await post(event());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    const s = db.sessionsByIds([SID])[0]!;
    expect(s.host).toBe("cloud");
    expect(stored.at(-1)?.sessions).toEqual([SID]);
  });

  test("one route — at its path, or at the root a funnel may strip it to — and everything else is a 404, not a 401", async () => {
    expect((await post(event(), `Bearer ${token}`, "/")).status).toBe(200);
    expect((await post(event(), `Bearer ${token}`, "/ingest")).status).toBe(404);
    expect((await post(event(), `Bearer ${token}`, "/sessions", "GET")).status).toBe(404);
    expect((await post(event(), `Bearer ${token}`, "/cloud/ingest", "GET")).status).toBe(404);
    expect((await post(event(), "", "/terminal/pty", "GET")).status).toBe(404);
  });

  test("only a cloud credential — not a node's, not none", async () => {
    expect((await post(event())).status).toBe(200);
    expect((await post(event(), `Bearer ${nodeToken}`)).status).toBe(401);
    expect((await post(event(), "Bearer nope")).status).toBe(401);
    expect((await post(event(), "")).status).toBe(401);
  });

  test("a body the normal intake would refuse is refused here", async () => {
    expect((await post({ ...event(), session_id: "" })).status).toBe(400);
    expect((await post({ ...event(), session_id: "unknown" })).status).toBe(400);
  });

  test("a cloud credential opens nothing on the main server", async () => {
    const { callerFor, allowed } = await import("../src/auth.ts");
    const req = new Request("http://127.0.0.1/sessions", { headers: { Authorization: `Bearer ${token}` } });
    const caller = callerFor(req, new URL(req.url), "machine-token")!;
    expect(caller.principal).toBe("cloud");
    for (const [m, p] of [["GET", "/sessions"], ["GET", "/stream"], ["GET", "/fleet/link"], ["POST", "/ingest"], ["GET", "/health"]]) {
      expect(allowed(caller, m!, p!)).toBe(false);
    }
  });
});

describe("the hook", () => {
  // A plain-HTTP listener that counts what reaches it. The hook insists on
  // https, so for the silence tests nothing should — and for the one case
  // that would post, the URL is http on purpose, so even a hook that forgot
  // its own rule would be caught here rather than going anywhere.
  let hits = 0;
  let srv: ReturnType<typeof Bun.serve>;
  beforeAll(() => { srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits++; return new Response("{}"); } }); });
  afterAll(() => srv.stop(true));

  const hook = new URL("../../hooks/cloud_hook.py", import.meta.url).pathname;
  const run = (env: Record<string, string>) => {
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ message: { model: "claude-opus-5", usage: { input_tokens: 1 } } }) + "\n");
    const p = Bun.spawnSync(["python3", hook], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: SID, hook_event_name: "Stop", cwd: "/home/user/webapp", transcript_path: transcript })),
      stdout: "pipe", stderr: "pipe",
    });
    return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
  };

  test("outside a cloud session it does nothing at all", () => {
    const r = run({ AGENTGLASS_CLOUD_URL: `https://127.0.0.1:${srv.port}`, AGENTGLASS_CLOUD_TOKEN: "t" });
    expect(r).toEqual({ code: 0, out: "", err: "" });
  });

  test("in a cloud session without its settings, it does nothing at all", () => {
    expect(run({ CLAUDE_CODE_REMOTE: "true" })).toEqual({ code: 0, out: "", err: "" });
    expect(run({ CLAUDE_CODE_REMOTE: "true", AGENTGLASS_CLOUD_URL: `https://127.0.0.1:${srv.port}` })).toEqual({ code: 0, out: "", err: "" });
  });

  test("a plain-HTTP hub is refused: the body is the session's content", () => {
    const before = hits;
    const r = run({ CLAUDE_CODE_REMOTE: "true", AGENTGLASS_CLOUD_URL: `http://127.0.0.1:${srv.port}`, AGENTGLASS_CLOUD_TOKEN: "t" });
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(hits).toBe(before);
  });

  test("a hub it cannot reach costs nothing but time, and says nothing", () => {
    // https to a port that speaks plain HTTP: the TLS handshake fails, which
    // is the shape of a hub that is down or misconfigured.
    const r = run({ CLAUDE_CODE_REMOTE: "true", AGENTGLASS_CLOUD_URL: `https://127.0.0.1:${srv.port}`, AGENTGLASS_CLOUD_TOKEN: "t" });
    expect(r).toEqual({ code: 0, out: "", err: "" });
  });
});

afterAll(removeScratch);
