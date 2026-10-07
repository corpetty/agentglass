// Two real servers, one forwarding to the other (docs/FLEET.md, phase 2).
//
// Everything that makes the link trustworthy is a property of the two
// processes together — the hub mints a credential bound to one name, the node
// finds its config without a restart, rows cross and land under that name, and
// a credential taken back at the hub stops the node — so this drives both for
// real, each with its own HOME, database and port.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { removeScratch, scratchDir } from "./scratch.ts";

const TOKEN = "hub-secret-for-fleet-link-test";
let root: string;
let hub: { base: string; proc: ReturnType<typeof Bun.spawn>; dir: string };
let node: { base: string; proc: ReturnType<typeof Bun.spawn>; dir: string };
let nodeToken = "";
let rooterToken = "";
let rooter: { base: string; proc: ReturnType<typeof Bun.spawn>; dir: string } | null = null;
let fakeDir = "";

/**
 * A stand-in for `claude` on rooter's PATH: says it started a session, says
 * one thing, and finishes — or, when told to be slow, starts and then waits,
 * so a test can stop it from the hub and see it die on rooter.
 */
function writeFakeClaude(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const script = `#!/bin/sh
echo "$@" > "${dir}/argv"
echo '{"type":"system","subtype":"init","session_id":"11111111-2222-4333-8444-555555555555"}'
if [ -f "${dir}/slow" ]; then echo $$ > "${dir}/pid"; sleep 30; fi
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from rooter"}]}}'
echo '{"type":"result","subtype":"success","result":"hello from rooter","session_id":"11111111-2222-4333-8444-555555555555"}'
`;
  writeFileSync(join(dir, "claude"), script, { mode: 0o755 });
}

async function boot(name: string, extra: Record<string, string>, pathFirst: string[] = []) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [...pathFirst, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      AGENTGLASS_DB: join(dir, "a.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_DISPATCH_DISABLED: "1",
      AGENTGLASS_TERMINAL_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      ...extra,
    },
    stdout: "ignore", stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return { base, proc, dir }; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`${name} did not come up: ` + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

/** `Response.json()` is `unknown` to the checker; these bodies are read loosely on purpose. */
const body = async (r: Promise<Response> | Response): Promise<any> => (await r).json();

const asHub = (path: string, init: RequestInit = {}) =>
  fetch(hub.base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

const nodeStatus = async () => (await body(fetch(node.base + "/fleet/status"))).upstream;

beforeAll(async () => {
  root = scratchDir(join(tmpdir(), "agx-fleet-link-"));
  [hub, node] = await Promise.all([
    boot("hub", { AGENTGLASS_HOST_ID: "hub", AGENTGLASS_TOKEN: TOKEN }),
    boot("node", { AGENTGLASS_HOST_ID: "bean" }),
  ]);
}, SERVER_BOOT_MS * 2);

afterAll(() => {
  for (const s of [hub, node, rooter]) try { s?.proc.kill(); } catch { /* gone */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* fine */ }
});

describe("joining a node to a hub", () => {
  test("the hub mints a credential bound to one name, once", async () => {
    const r = await body(asHub("/fleet/nodes", { method: "POST", body: JSON.stringify({ host: "bean" }) }));
    expect(r.ok).toBe(true);
    expect(r.device.host).toBe("bean");
    expect(r.device.hash).toBeUndefined();
    nodeToken = r.token;
    const again = await asHub("/fleet/nodes", { method: "POST", body: JSON.stringify({ host: "bean" }) });
    expect(again.status).toBe(409);
    const own = await asHub("/fleet/nodes", { method: "POST", body: JSON.stringify({ host: "hub" }) });
    expect(own.status).toBe(400);
  });

  test("rows written on the node arrive on the hub under its name, without a restart", async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(node.base + "/ingest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_app: "proj", session_id: "link-s1", hook_event_type: "PostToolUse", payload: { tool_name: "Bash", cwd: "/home/u/proj" } }),
      });
    }
    // Written behind the running node's back, as `bun run fleet join` does —
    // which creates the directory too; a fresh node may not have yet.
    mkdirSync(join(node.dir, "agentglass"), { recursive: true });
    writeFileSync(join(node.dir, "agentglass", "upstream.json"), JSON.stringify({ url: hub.base, token: nodeToken }), { mode: 0o600 });
    const sessions = await until("the session on the hub", async () => {
      const list = await body(asHub("/sessions?host=bean"));
      return list.find((s: any) => s.session_id === "link-s1" && s.event_count === 3) ? list : null;
    });
    expect(sessions.every((s: any) => s.host === "bean")).toBe(true);
    const st = await nodeStatus();
    expect(st.state).toBe("live");
    expect(st.hubHost).toBe("hub");
    const nodes = await body(asHub("/fleet/nodes"));
    expect(nodes.nodes.find((n: any) => n.host === "bean")?.connected).toBe(true);
  }, 30_000);

  test("a new row follows within a couple of seconds", async () => {
    await fetch(node.base + "/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_app: "proj", session_id: "link-s1", hook_event_type: "Stop", payload: { cwd: "/home/u/proj" } }),
    });
    await until("the Stop on the hub", async () => {
      const evs = await body(asHub("/events/recent?host=bean"));
      return evs.some((e: any) => e.hook_event_type === "Stop");
    }, 5000);
  });

  test("the node credential is good for the link and nothing else on the hub", async () => {
    const r = await fetch(hub.base + "/sessions", { headers: { Authorization: `Bearer ${nodeToken}` } });
    expect(r.status).toBe(403);
  });

  test("a credential cannot forward as a name it was not minted for", async () => {
    const r = await body(asHub("/fleet/nodes", { method: "POST", body: JSON.stringify({ host: "rooter" }) }));
    rooterToken = r.token;
    const ws = new WebSocket(hub.base.replace("http", "ws") + "/fleet/link", {
      headers: { Authorization: `Bearer ${r.token}` },
    } as unknown as string[]);
    const frame = await new Promise<any>((res, rej) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", v: 1, host: "bean" })));
      ws.addEventListener("message", (e) => res(JSON.parse(String((e as MessageEvent).data))));
      ws.addEventListener("close", () => rej(new Error("closed without an answer")));
    });
    expect(frame.t).toBe("refuse");
    expect(frame.error).toContain("rooter");
    // And the real bean is still linked — the impostor did not displace it.
    const nodes = await body(asHub("/fleet/nodes"));
    expect(nodes.nodes.find((n: any) => n.host === "bean")?.connected).toBe(true);
  });

  test("the hub will not resume another machine's session here", async () => {
    const r = await asHub("/chat/send", {
      method: "POST",
      body: JSON.stringify({ cwd: hub.dir, message: "carry on", resumeId: "link-s1" }),
    });
    expect(r.status).toBe(409);
    expect((await body(r)).error).toContain("bean");
  });

  test("a hub joined at runtime moves rows but does not take gate answers until a restart", async () => {
    // The node was running before upstream.json existed; an agent on it could
    // have written that file. See `pinned` in fleetlink.ts.
    expect((await nodeStatus()).gates).toBe("restart");
  });

  test("a hold on a node is answered at the hub and takes effect on the node", async () => {
    // rooter starts already configured, which is the case where answers are taken.
    fakeDir = join(root, "fake-claude");
    writeFakeClaude(fakeDir);
    rooter = await boot("rooter", {
      AGENTGLASS_HOST_ID: "rooter",
      AGENTGLASS_UPSTREAM_URL: hub.base,
      AGENTGLASS_UPSTREAM_TOKEN: rooterToken,
      // Configured at start, so the chat tier is in force (see tierInForce).
      AGENTGLASS_UPSTREAM_TUNNEL: "chat",
    }, [fakeDir]);
    const rooterBase = rooter.base;
    await until("rooter's link", async () => (await body(fetch(rooterBase + "/fleet/status"))).upstream.state === "live");
    expect((await body(fetch(rooterBase + "/fleet/status"))).upstream.gates).toBe("relayed");

    const id = crypto.randomUUID();
    // The hook's held request, on rooter. It does not answer until decided.
    const held = fetch(rooterBase + "/gate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, source_app: "proj", session_id: "gate-s1", tool_name: "Bash", tool_input: { command: "rm -rf build" }, timeout_ms: 60_000 }),
    }).then((r) => body(r));

    const g = await until("the hold on the hub", async () =>
      (await body(asHub("/gate/pending"))).gates.find((x: any) => x.id === id));
    expect(g.host).toBe("rooter");

    // The party being held may not release itself: no Origin, no device — refused
    // here exactly as a local hold would be.
    const blocked = await asHub("/gate/decide", { method: "POST", body: JSON.stringify({ id, decision: "allow" }) });
    expect(blocked.status).toBe(403);

    // A person at the hub's desk denies it.
    const r = await body(asHub("/gate/decide", {
      method: "POST", headers: { Origin: hub.base },
      body: JSON.stringify({ id, decision: "deny", reason: "not on the box" }),
    }));
    expect(r.ok).toBe(true);
    const outcome = await held;
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toBe("not on the box");
    // Recorded on rooter, as rooter's hold, decided via the hub.
    const hist = await body(fetch(rooterBase + "/gate/history"));
    const row = hist.gates.find((x: any) => x.id === id);
    expect(row.resolution).toBe("human");
    expect(row.decided_by).toContain("via hub");
    // And gone from the hub's queue once rooter says so.
    await until("the hub's queue to clear", async () =>
      !(await body(asHub("/gate/pending"))).gates.some((x: any) => x.id === id), 5000);
  }, 60_000);

  test("the hub reads a node's repository through the link, and cannot write to it", async () => {
    // A real repository on rooter's disk, which the hub has no path to.
    const repo = join(rooter!.dir, "proj");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { stdout: "pipe", stderr: "pipe" });
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git("add", "-A"); git("commit", "-qm", "first on rooter");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");

    const proxied = (method: string, path: string, b?: unknown) => asHub("/fleet/proxy", {
      method: "POST", headers: { Origin: hub.base },
      body: JSON.stringify({ host: "rooter", method, path, ...(b !== undefined ? { body: b } : {}) }),
    });
    const log = await proxied("GET", `/git/log?root=${encodeURIComponent(repo)}`);
    expect(log.status).toBe(200);
    expect(JSON.stringify(await body(log))).toContain("first on rooter");
    const st = await body(proxied("POST", "/git/status", { paths: [join(repo, "a.txt")] }));
    expect(JSON.stringify(st)).toContain("a.txt");

    // A write is refused at the hub, before it is ever forwarded …
    const stage = await proxied("POST", "/git/stage", { root: repo, paths: ["a.txt"] });
    expect(stage.status).toBe(403);
    // … and so is anything outside the workspace views, read or not.
    expect((await proxied("GET", "/sessions")).status).toBe(403);
    expect((await proxied("GET", "/terminal/pty")).status).toBe(403);
    // Nothing was staged on rooter.
    expect(new TextDecoder().decode(git("diff", "--cached", "--name-only").stdout).trim()).toBe("");
  }, 30_000);

  test("a node says what it opens, and the hub can tell", async () => {
    const nodes = (await body(asHub("/fleet/nodes"))).nodes;
    expect(nodes.find((n: any) => n.host === "rooter")?.tunnel).toBe("chat");
    // bean joined at runtime with the default: read.
    expect(nodes.find((n: any) => n.host === "bean")?.tunnel).toBe("read");
  });

  test("a turn sent at the hub runs on rooter and streams back", async () => {
    const repo = join(rooter!.dir, "proj");
    const r = await asHub("/fleet/proxy", {
      method: "POST", headers: { Origin: hub.base },
      body: JSON.stringify({ host: "rooter", method: "POST", path: "/chat/send", body: { cwd: repo, message: "say hello", model: "claude-opus-5" } }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("ndjson");
    const text = await r.text();
    expect(text).toContain("hello from rooter");
    expect(text).toContain("11111111-2222-4333-8444-555555555555");
    // It ran on rooter, as a turn: rooter's fake claude saw the arguments.
    expect(readFileSync(join(fakeDir, "argv"), "utf8")).toContain("-p");
  }, 30_000);

  test("a node at the read tier will not take a turn", async () => {
    const r = await asHub("/fleet/proxy", {
      method: "POST", headers: { Origin: hub.base },
      body: JSON.stringify({ host: "bean", method: "POST", path: "/chat/send", body: { cwd: "/tmp", message: "hi" } }),
    });
    expect(r.status).toBe(403);
    expect((await body(r)).error).toContain("bean");
  });

  test("stopping a turn at the hub stops it on rooter", async () => {
    const repo = join(rooter!.dir, "proj");
    writeFileSync(join(fakeDir, "slow"), "1");
    try { rmSync(join(fakeDir, "pid")); } catch { /* first run */ }
    const ctl = new AbortController();
    const r = await asHub("/fleet/proxy", {
      method: "POST", headers: { Origin: hub.base }, signal: ctl.signal,
      body: JSON.stringify({ host: "rooter", method: "POST", path: "/chat/send", body: { cwd: repo, message: "take your time", model: "claude-opus-5" } }),
    });
    const reader = r.body!.getReader();
    await reader.read(); // the init line: it is running
    const pid = Number(await until("the fake claude's pid", async () => {
      try { return readFileSync(join(fakeDir, "pid"), "utf8").trim() || null; } catch { return null; }
    }, 5000));
    expect(pid).toBeGreaterThan(0);
    ctl.abort();
    await until("the turn to die on rooter", async () => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 10_000);
    rmSync(join(fakeDir, "slow"));
  }, 30_000);

  test("a node that is not linked answers as such", async () => {
    const r = await asHub("/fleet/proxy", {
      method: "POST", headers: { Origin: hub.base },
      body: JSON.stringify({ host: "nobody", method: "GET", path: "/git/repos" }),
    });
    expect(r.status).toBe(502);
  });

  test("an answer for a hold nobody is keeping says so", async () => {
    const r = await body(asHub("/gate/decide", {
      method: "POST", headers: { Origin: hub.base },
      body: JSON.stringify({ id: crypto.randomUUID(), decision: "allow" }),
    }));
    expect(r.ok).toBe(false);
  });

  test("forgetting the credential at the hub stops the node", async () => {
    const creds = (await body(asHub("/fleet/nodes"))).credentials;
    const id = creds.find((c: any) => c.host === "bean").id;
    const r = await body(asHub("/pair/forget", { method: "POST", body: JSON.stringify({ id }) }));
    expect(r.closed).toBeGreaterThanOrEqual(1);
    const st = await until("the node to notice", async () => {
      const s = await nodeStatus();
      return s.state === "refused" ? s : null;
    }, 10_000);
    expect(st.error).toBeTruthy();
  }, 20_000);
});

afterAll(removeScratch);
