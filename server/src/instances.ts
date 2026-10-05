// Desktop instance manager — launch/stop/detect the Claude Desktop (Electron)
// app's isolated profiles from the cockpit.
//
// Each instance is a profile keyed by its Electron --user-data-dir:
//   * "default" — the normal profile at ~/.config/Claude.
//   * "<name>"  — an isolated one under ~/.claude-instances/<name>, launched
//                 with XDG_CONFIG_HOME=<dir>/config so Electron writes its data
//                 to <dir>/config/Claude (the pattern the setup doc uses).
//
// This is process-level management only — launch, stop, and detect. It does NOT
// drive the app (no message injection); queued *work* goes through the CLI
// dispatcher, per the harness design. `claude://` login-callback routing is a
// one-time manual setup (see the companion doc), out of scope here.

import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { listAccounts } from "./accounts.ts";
import { failed } from "./refused.ts";
import type { DesktopInstance } from "../../shared/types.ts";

export const INSTANCES_ENABLED = process.env.AGENTGLASS_INSTANCES_DISABLED !== "1";
const INSTANCES_ROOT = join(homedir(), ".claude-instances");
const DEFAULT_DATA_DIR = join(homedir(), ".config", "Claude");
const DEFAULT_NAME = "default";

/** The desktop binary, if installed. The upgrade renamed it from
 *  `claude-desktop` to `claude-desktop-unofficial`; try both, and honor an
 *  explicit override. */
function desktopBin(): string | null {
  const override = process.env.AGENTGLASS_DESKTOP_BIN;
  if (override) return existsSync(override) ? override : null;
  return Bun.which("claude-desktop-unofficial") || Bun.which("claude-desktop") || null;
}

interface InstanceConfig { name: string; dataDir: string; configHome: string | null; isDefault: boolean; }

/** The instance definitions on disk: the default profile plus one per
 *  ~/.claude-instances/<name> directory. */
function configs(): InstanceConfig[] {
  const out: InstanceConfig[] = [{ name: DEFAULT_NAME, dataDir: DEFAULT_DATA_DIR, configHome: null, isDefault: true }];
  let dirs: string[] = [];
  try { dirs = readdirSync(INSTANCES_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { /* no ~/.claude-instances — only the default profile exists */ }
  for (const name of dirs) {
    const configHome = join(INSTANCES_ROOT, name, "config");
    out.push({ name, dataDir: join(configHome, "Claude"), configHome, isDefault: false });
  }
  return out;
}

/** Map of running data-dir → PIDs, parsed from the process table. A profile is
 *  "running" when any process (the Electron main or one of its helpers) carries
 *  its --user-data-dir. */
function runningByDataDir(): Map<string, number[]> {
  const map = new Map<string, number[]>();
  try {
    const p = Bun.spawnSync(["pgrep", "-af", "claude-desktop"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return map; // pgrep exits 1 when nothing matches
    for (const line of p.stdout.toString().split("\n")) {
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const dd = m[2].match(/--user-data-dir=(\S+)/);
      if (!dd) continue;
      const dir = dd[1];
      (map.get(dir) ?? map.set(dir, []).get(dir)!).push(pid);
    }
  } catch { /* pgrep missing — treat as nothing running */ }
  return map;
}

/** Every known instance, with live running state and its linked account. */
export function listInstances(): DesktopInstance[] {
  const manageable = INSTANCES_ENABLED && !!desktopBin();
  const running = runningByDataDir();
  // Reverse the registry's desktop_instance links: instance name → account id.
  const linkByInstance = new Map<string, string>();
  for (const a of listAccounts()) if (a.desktopInstance) linkByInstance.set(a.desktopInstance, a.id);
  return configs().map((c) => {
    const pids = running.get(c.dataDir) ?? [];
    return {
      name: c.name,
      dataDir: c.dataDir,
      running: pids.length > 0,
      pids,
      account: linkByInstance.get(c.name) ?? null,
      isDefault: c.isDefault,
      manageable,
    };
  });
}

function configFor(name: string): InstanceConfig | null {
  return configs().find((c) => c.name === name) ?? null;
}

/** Launch an instance detached, so it outlives the server. Idempotent — a
 *  running instance is left alone. */
export function launchInstance(name: string): { ok: boolean; error?: string; note?: string } {
  if (!INSTANCES_ENABLED) return { ok: false, error: "instance management is disabled" };
  const bin = desktopBin();
  if (!bin) return { ok: false, error: "Claude Desktop binary not found" };
  const cfg = configFor(name);
  if (!cfg) return { ok: false, error: `unknown instance: ${name}` };
  if ((runningByDataDir().get(cfg.dataDir) ?? []).length) return { ok: true, note: "already running" };

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // The isolation: point XDG_CONFIG_HOME at this instance's config dir so
  // Electron keys all its state (and its single-instance lock) to a distinct
  // profile. For the default profile, clear any inherited XDG so it falls back
  // to ~/.config rather than wherever the server was configured.
  if (cfg.configHome) env.XDG_CONFIG_HOME = cfg.configHome;
  else delete env.XDG_CONFIG_HOME;

  // setsid detaches into its own session so the app survives a server restart;
  // stdio is discarded so a full pipe can't block it.
  const setsid = Bun.which("setsid");
  try {
    const proc = Bun.spawn(setsid ? [setsid, bin] : [bin], { env, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    proc.unref();
  } catch (e) {
    return { ok: false, error: failed("instances", e, "Claude Desktop could not be launched") };
  }
  return { ok: true };
}

/** Stop an instance by SIGTERM-ing every process carrying its data dir (the
 *  Electron main and its helpers). Idempotent — a stopped instance is a no-op. */
export function stopInstance(name: string): { ok: boolean; error?: string; stopped?: number } {
  if (!INSTANCES_ENABLED) return { ok: false, error: "instance management is disabled" };
  const cfg = configFor(name);
  if (!cfg) return { ok: false, error: `unknown instance: ${name}` };
  const pids = runningByDataDir().get(cfg.dataDir) ?? [];
  if (!pids.length) return { ok: true, stopped: 0 };
  let stopped = 0;
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); stopped++; } catch { /* already gone */ }
  }
  return { ok: true, stopped };
}
