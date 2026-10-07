// The fleet link, arriving from another machine (docs/FLEET.md, phase 2).
//
// fleet-link.test.ts drives the link over loopback, and that is exactly how it
// missed the first real deployment: a node reaches its hub through `tailscale
// serve`, so the hub sees a REMOTE caller with no Origin — and the browser CSRF
// gate the route used then refused every link before reading its credential.
// Here the hub listens on this machine's own network address and the node
// dials that address, so the socket peer is not loopback, as on a real tailnet.
//
// What must stay true while letting nodes in: a browser page (which always
// sends an Origin) is still refused, and nothing gets in without a node
// credential.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "hub-secret-for-remote-link-test";

/** A private IPv4 address of this machine that is not loopback — what a
 *  tailnet or LAN peer would reach the hub on. None (a box with only lo) →
 *  the suite is skipped rather than pretending loopback is remote. */
function privateAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [x, y] = a.address.split(".").map(Number);
      if (x === 10 || (x === 192 && y === 168) || (x === 172 && y! >= 16 && y! <= 31) || (x === 100 && y! >= 64 && y! <= 127)) return a.address;
    }
  }
  return null;
}

const addr = privateAddress();
let root = "";
let port = 0;
let proc: ReturnType<typeof Bun.spawn> | null = null;
let nodeToken = "";

beforeAll(async () => {
  if (!addr) return;
  root = mkdtempSync(join(tmpdir(), "agx-remote-link-"));
  const dir = join(root, "hub");
  mkdirSync(dir, { recursive: true });
  port = await freePort();
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: join(dir, "state"), CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      AGENTGLASS_DB: join(dir, "a.db"), AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_DISPATCH_DISABLED: "1",
      AGENTGLASS_TERMINAL_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_HOST_ID: "hub",
      // A network bind, the way a reachable hub is configured.
      AGENTGLASS_BIND: "0.0.0.0", AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_TRUST_LAN: "1",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  // Minted at the hub's own machine, over loopback, as the CLI does.
  const r = await (await fetch(`http://127.0.0.1:${port}/fleet/nodes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ host: "bean" }),
  })).json() as { token: string };
  nodeToken = r.token;
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* gone */ }
  if (root) try { rmSync(root, { recursive: true, force: true }); } catch { /* fine */ }
});

/** The status line the hub answers a WebSocket upgrade with, from the network
 *  address — raw, so the request carries exactly the headers named here. */
async function upgradeStatus(headers: Record<string, string>): Promise<number> {
  const lines = [
    "GET /fleet/link HTTP/1.1", `Host: ${addr}:${port}`, "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", "",
  ];
  return new Promise((resolve, reject) => {
    let buf = "";
    Bun.connect({
      hostname: addr!, port,
      socket: {
        open(s) { s.write(lines.join("\r\n")); },
        data(s, d) {
          buf += new TextDecoder().decode(d);
          const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
          if (m) { resolve(Number(m[1])); s.end(); }
        },
        error(_s, e) { reject(e); },
      },
    }).catch(reject);
  });
}

describe.skipIf(!addr)("a node linking from another address", () => {
  test("its credential links, and it is greeted", async () => {
    const ws = new WebSocket(`ws://${addr}:${port}/fleet/link`, {
      headers: { Authorization: `Bearer ${nodeToken}` },
    } as unknown as string[]);
    const frame = await new Promise<any>((res, rej) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ t: "hello", v: 1, host: "bean" })));
      ws.addEventListener("message", (e) => res(JSON.parse(String((e as MessageEvent).data))));
      ws.addEventListener("close", (e) => rej(new Error(`closed ${(e as CloseEvent).code}`)));
    });
    ws.close();
    expect(frame.t).toBe("welcome");
    expect(frame.host).toBe("hub");
  });

  test("a browser page from elsewhere is still refused, credential or not", async () => {
    expect(await upgradeStatus({ Authorization: `Bearer ${nodeToken}`, Origin: "https://evil.example" })).toBe(403);
  });

  test("nothing links without a node credential", async () => {
    expect(await upgradeStatus({})).toBe(401);
    expect(await upgradeStatus({ Authorization: `Bearer ${TOKEN}` })).toBe(401); // the hub's own token is not a node's
  });
});
