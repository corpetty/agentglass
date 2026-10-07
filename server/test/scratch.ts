/*
 * Scratch directories, taken away by the file that made them.
 *
 * Every test file that makes a directory under /tmp makes it with
 * `scratchDir()` instead of `mkdtempSync()`, and ends with
 *
 *     afterAll(removeScratch);
 *
 * as its LAST top-level statement. bun runs `afterAll` hooks in the order they
 * were registered (measured on 1.4.1), so registered last it runs after the
 * file's own teardown — after a server the file started has been stopped, not
 * while it is still writing into the directory. It runs when a test fails too.
 *
 * tmpsweep.ts already removes everything a run made, at the end of the run.
 * That is a preload, and bun reads a preload from the bunfig.toml in the
 * directory it was STARTED in: the repository root and `server/` have one,
 * `server/test/`, `~` and everywhere else do not. Measured on 2026-10-07:
 * 1,559 `agx-*` directories in /tmp, all from runs whose preload never loaded,
 * and /tmp there is a tmpfs, so RAM. This file is the half that does not
 * depend on where the run was started from.
 *
 * And the tmux servers, which are the expensive half. A server a test started
 * daemonizes and outlives everything; once the directory its socket is in has
 * been removed, nothing can reach it with `-L` or `-S` again and it runs until
 * the machine reboots — 14 of them, two days old, when counted. So before any
 * directory goes, every tmux server with a socket inside one is stopped, and
 * then any tmux process whose arguments still carry this run's `agx-…-<pid>`
 * name is killed by pid — which also stops one whose socket a file's own
 * teardown has already removed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { killServersUnder } from "./tmpreap.ts";

/** Paths made since the last `removeScratch()`, newest last. Files run one at
 *  a time in a `bun test` process, so this is the current file's. */
const made: string[] = [];

/** `process.env` as the preloads left it, before any file had changed it. */
const envAtLoad: Record<string, string | undefined> = { ...process.env };
/** `process.env` as it was when the current file started: at the first import,
 *  then again at the end of each `removeScratch()`. */
let envAtStart: Record<string, string | undefined> = { ...envAtLoad };

/** `mkdtempSync`, same arguments, and the directory is recorded for `removeScratch()`. */
export function scratchDir(prefix: string, options?: Parameters<typeof mkdtempSync>[1]): string {
  const dir = mkdtempSync(prefix, options) as string;
  made.push(dir);
  return dir;
}

/** A path made some other way — a fixed `agx-…-<pid>` directory, a symlink,
 *  a socket file — to be removed with the rest. Returns it, for inline use. */
export function trackScratch<T extends string>(path: T): T {
  made.push(path);
  return path;
}

/**
 * Register with `afterAll(removeScratch)` as the last line of the file.
 *
 * Every server is stopped before any directory is removed: first by its socket,
 * while the socket is still there to be found, then by pid for anything that
 * did not answer. Only then do the directories go, newest first.
 */
export function removeScratch(): void {
  const paths = made.splice(0).reverse();
  for (const p of paths) killServersUnder(p);
  killRunTmux();
  for (const p of paths) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  restoreEnv(paths);
  envAtStart = { ...process.env };
}

/*
 * A variable still pointing into a directory that was just removed goes back to
 * what it was when the file started.
 *
 * Removing a file's directories is not enough on its own, because `bun test`
 * runs every file in one process and a file that sets `XDG_CONFIG_HOME` or
 * `AGENTGLASS_STATE_DIR` to its scratch directory rarely sets it back. The
 * next file to write a setting writes it there, and the directory is back.
 * Measured, with the end-of-run sweep switched off: 21 directories removed by
 * the file that made them and recreated by a later one — `notify-prefs.json`,
 * `mirror-leases.json`, a tmux conf. Only a variable that points into a removed
 * path is touched: that value refers to nothing now, so no later file can
 * be relying on it.
 *
 * When the value the file started with is gone too, or was never set — a file
 * before it deleted the variable and did not put it back — the one the
 * preloads set is next, and only then is the variable deleted. Deleting first
 * took `XDG_CONFIG_HOME` away from isolation.test.ts, which holds every XDG
 * base to being set, and scratch.
 *
 * CEILING: a path held inside a module, not the environment (a store path
 * set through a `__set…` hook, an open database), is not reached from here.
 * The end-of-run sweep in tmpsweep.ts is what removes those.
 */
function restoreEnv(paths: string[]): void {
  const removed = (v: string | undefined) => !!v && paths.some((p) => v === p || v.startsWith(p + "/"));
  for (const [k, v] of Object.entries(process.env)) {
    if (!removed(v)) continue;
    const was = [envAtStart[k], envAtLoad[k]].find((x) => x !== undefined && !removed(x));
    if (was === undefined) delete process.env[k];
    else process.env[k] = was;
  }
}

/**
 * Every tmux process whose arguments carry this run's pid in an `agx-` name:
 * `-L agx-restore-test-123`, `-S /tmp/agx-test-tmux-123/…`,
 * `-f /tmp/agx-restore-state-123/tmux/tmux.conf`. That naming is the house
 * convention for anything a test points tmux at (tmuxleak.ts), and the pid is
 * what keeps it from touching another run's servers or the developer's own.
 *
 * Found through `ps`, not a socket, because this is for the server whose socket
 * is gone. SIGTERM first, which tmux handles like `kill-server`; SIGKILL for
 * one that is still there a moment later.
 */
export function killRunTmux(pid = process.pid): number[] {
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,args="], { stdout: "pipe", stderr: "ignore" });
  if (ps.exitCode !== 0) return [];
  const ours = new RegExp(`agx-[A-Za-z0-9_.-]*-${pid}(?![0-9])`);
  const hit: number[] = [];
  for (const line of ps.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line);
    if (!m || !/(^|\/)tmux:?$/.test(m[2]!) || !ours.test(m[2]! + m[3]!)) continue;
    const target = Number(m[1]);
    try { process.kill(target, "SIGTERM"); hit.push(target); } catch { /* gone, or not ours */ }
  }
  if (!hit.length) return hit;
  const deadline = Date.now() + 1000;
  for (const target of hit) {
    while (alive(target) && Date.now() < deadline) Bun.sleepSync(20);
    if (alive(target)) try { process.kill(target, "SIGKILL"); } catch { /* gone */ }
  }
  return hit;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
