// The dispatcher — runs queued jobs as headless `claude -p`, one account at a
// time, within the guarantees that make an unattended run safe:
//
//   * COST: every job runs under an account's subscription login
//     (CLAUDE_CONFIG_DIR) with ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN STRIPPED
//     from its environment, so a job can never fall back to metered API billing.
//     Exhausting a subscription limit blocks the request; it never spends money.
//   * RUNAWAY: --max-turns is mandatory on every run, so a looping job can't
//     burn a whole window of quota.
//   * LOAD: one headless job per account at a time, and accounts above a
//     utilization threshold are skipped until they reset — the scheduler smooths
//     load rather than spiking it.
//
// This file has two halves: execute() (one job → one `claude -p` run, below)
// and the policy loop (which job × which account, in loop.ts-style tick — added
// in the dispatcher loop section).

import { accountById, listAccounts, type Account } from "./accounts.ts";
import type { Job } from "../../shared/types.ts";
import { safeAbs, repoRootOf } from "./git.ts";
import { existsSync } from "node:fs";
import { getUsage } from "./usage.ts";
import {
  queuedJobs, jobsByStatus, resolveBlocked, runningCountByAccount,
  markRunning, markDone, failAttempt, requeueNoPenalty, markExpired, recoverInterrupted,
} from "./queue.ts";

const claudeBin = () => Bun.which("claude");

/** Hard wall-clock ceiling per run — a job that produces nothing (a hung tool,
 *  a wedged MCP server) must not hold its account's slot forever. */
const RUN_TIMEOUT_MS = Math.max(60_000, Number(process.env.AGENTGLASS_JOB_TIMEOUT_MS || 30 * 60_000));
/** Like chat.ts: a run that says nothing at all early on is almost always a CLI
 *  waiting for a login it can't get here. */
const STARTUP_TIMEOUT_MS = Number(process.env.AGENTGLASS_JOB_STARTUP_TIMEOUT_MS ?? 30_000);

const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|too many requests|\b429\b|limit reached|resets? at/i;

export interface RunOutcome {
  ok: boolean;
  session_id: string | null;
  summary: string | null;
  error: string | null;
  /** The account's limit was hit mid-run — not the job's fault; requeue it and
   *  pause the account until reset. */
  rateLimited: boolean;
  /** ISO reset time parsed from the limit message, when present. */
  resetAt: string | null;
}

/** The child environment for a run: the parent env, pointed at this account's
 *  login, with every API-key credential removed so the run bills to the
 *  subscription and nothing else. This is the cost guarantee, enforced in code
 *  rather than trusted to configuration. */
function childEnv(account: Account): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // The whole point — a job never authenticates with a metered key.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // A dispatched job is a separate-account session, not a nested one — but if
  // the server itself was launched from inside a Claude Code session, CLAUDECODE
  // would be inherited and `claude -p` would refuse to start ("cannot be
  // launched inside another Claude Code session"). Clear it so a job always runs.
  delete env.CLAUDECODE;
  env.CLAUDE_CONFIG_DIR = account.configDir;
  // So the hooks (and the fallback scanner) attribute the run to this account.
  env.AGENTGLASS_ACCOUNT = account.id;
  // Belt-and-braces: don't let a job's own claude re-ingest as a phantom via a
  // recursive hook — its transcript is picked up from the account's projects dir.
  return env;
}

/** Run one job on one account. Resolves when the process exits (or the wall
 *  clock / startup watchdog fires). Never rejects — every failure is an outcome. */
export async function execute(job: Job, account: Account): Promise<RunOutcome> {
  const fail = (error: string): RunOutcome => ({ ok: false, session_id: null, summary: null, error, rateLimited: false, resetAt: null });

  const bin = claudeBin();
  if (!bin) return fail("no local `claude` CLI");

  const dir = safeAbs(job.cwd);
  if (!dir || !repoRootOf(dir)) return fail("cwd is not a git repository");

  // The account must actually be logged in — otherwise `claude -p` blocks on an
  // auth prompt it can't answer, which the startup watchdog would eventually
  // kill, but failing fast here is clearer.
  if (!existsSync(account.credentialsPath)) return fail(`account ${account.id} is not logged in (${account.credentialsPath})`);

  const args = [bin, "-p", "--output-format", "stream-json", "--verbose", "--max-turns", String(job.max_turns)];
  if (job.model) args.push("--model", job.model);
  if (job.permission_mode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", job.permission_mode);
  if (job.permission_mode !== "bypassPermissions" && job.allowed_tools.length) args.push("--allowedTools", ...job.allowed_tools);

  // Own process group, so a timeout kill reaches the whole tool tree the job
  // spawned (a test run, a dev server), not just the claude process.
  const setsid = Bun.which("setsid");
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(setsid ? [setsid, ...args] : args, {
      cwd: dir,
      stdin: new TextEncoder().encode(job.prompt),
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(account),
    });
  } catch (e) {
    return fail(`spawn failed: ${e instanceof Error ? e.message : e}`);
  }

  const kill = () => { try { if (setsid && proc.pid) process.kill(-proc.pid, "SIGTERM"); else proc.kill(); } catch { /* gone */ } };
  const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");

  let sessionId: string | null = null;
  let resultText: string | null = null;
  let isError = false;
  let rateLimited = false;
  let resetAt: string | null = null;
  let sawOutput = false;
  let timedOut = false;

  const hardTimer = setTimeout(() => { timedOut = true; kill(); }, RUN_TIMEOUT_MS);
  const startTimer = setTimeout(() => { if (!sawOutput) { timedOut = true; kill(); } }, STARTUP_TIMEOUT_MS);

  const note = (o: any) => {
    // system/init carries the session id we link the job to.
    if (o?.type === "system" && (o.subtype === "init" || o.session_id)) sessionId ??= typeof o.session_id === "string" ? o.session_id : null;
    if (typeof o?.session_id === "string" && !sessionId) sessionId = o.session_id;
    if (o?.type === "result") {
      isError = o.is_error === true || (typeof o.subtype === "string" && o.subtype !== "success");
      if (typeof o.result === "string") resultText = o.result;
      const blob = `${o.result ?? ""} ${o.error ?? ""} ${o.subtype ?? ""}`;
      if (RATE_LIMIT_RE.test(blob)) { rateLimited = true; const m = blob.match(/\d{4}-\d\d-\d\dT[\d:.+Z-]+/); if (m) resetAt = m[0]; }
    }
    if (o?.type === "error" || o?.type === "agx_error") {
      isError = true;
      const blob = `${o.error ?? ""} ${o.message ?? ""}`;
      if (RATE_LIMIT_RE.test(blob)) rateLimited = true;
      if (!resultText) resultText = String(o.error ?? o.message ?? "error");
    }
  };

  // Read stream-json line by line off stdout.
  try {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) { sawOutput = true; clearTimeout(startTimer); }
      buf += dec.decode(value ?? new Uint8Array(), { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { note(JSON.parse(line)); } catch { /* keepalive / non-json */ } }
      }
    }
    if (buf.trim()) { try { note(JSON.parse(buf.trim())); } catch { /* ignore */ } }
  } catch { /* stream closed */ }

  const code = await proc.exited;
  clearTimeout(hardTimer);
  clearTimeout(startTimer);

  if (rateLimited) return { ok: false, session_id: sessionId, summary: null, error: "account rate-limited mid-run", rateLimited: true, resetAt };
  if (timedOut) return { ok: false, session_id: sessionId, summary: resultText, error: !sawOutput ? `no output in ${STARTUP_TIMEOUT_MS / 1000}s — the account may need a fresh login` : `exceeded ${RUN_TIMEOUT_MS / 1000}s wall-clock`, rateLimited: false, resetAt: null };
  if (code !== 0 || isError) {
    const stderr = (await Promise.race([stderrText, Promise.resolve("")])).trim();
    return { ok: false, session_id: sessionId, summary: resultText, error: (resultText || stderr || `claude exited ${code}`).slice(0, 2000), rateLimited: false, resetAt: null };
  }
  return { ok: true, session_id: sessionId, summary: resultText, error: null, rateLimited: false, resetAt: null };
}

// ---------------------------------------------------------------------------
// Policy loop — which job runs on which account, every tick.
// ---------------------------------------------------------------------------

const TICK_MS = Math.max(5_000, Number(process.env.AGENTGLASS_DISPATCH_INTERVAL_MS || 30_000));
/** Headless jobs per account at once. One keeps the load human-shaped and the
 *  ToS posture conservative; raise deliberately. */
const CONCURRENCY = Math.max(1, Number(process.env.AGENTGLASS_JOB_CONCURRENCY || 1));
/** The utilization (max of 5h and weekly %) at or above which the queue will
 *  NOT start new work on an account — this is the "interactive reserve" that
 *  leaves headroom for the human at the keyboard. Queue jobs never push an
 *  account past this; interactive use still can. */
const CEILING = Math.max(1, Math.min(100, Number(process.env.AGENTGLASS_QUEUE_CEILING || 80)));
export const DISPATCH_ENABLED = process.env.AGENTGLASS_DISPATCH_DISABLED !== "1" && !!claudeBin();

/** Accounts paused until a moment in time after hitting a rate limit — skipped
 *  by the picker until then, independent of the (cached, slower) usage meter. */
const pausedUntil = new Map<string, number>();

/** Optional hook so the API/alerts layer can react to job lifecycle without this
 *  module importing it. Set by startDispatcher's caller. */
type DispatchEvent =
  | { kind: "done"; job: Job; account: string; session_id: string | null }
  | { kind: "failed"; job: Job; account: string; error: string }
  | { kind: "paused"; account: string; until: number };
let onEvent: (e: DispatchEvent) => void = () => {};
export function onDispatch(fn: (e: DispatchEvent) => void): void { onEvent = fn; }

function inWindow(job: Job, now: number): boolean {
  if (job.window_start != null && now < job.window_start) return false;
  if (job.window_end != null && now > job.window_end) return false;
  return true;
}

/** Queued/blocked jobs whose window has closed can never run — retire them. */
function expireStale(now: number): void {
  for (const status of ["queued", "blocked"] as const) {
    for (const job of jobsByStatus(status)) {
      if (job.window_end != null && now > job.window_end) markExpired(job.id);
    }
  }
}

/** The account with the most headroom that may take this job right now, or null.
 *  "Most headroom" = lowest binding-bucket utilization (max of 5h and weekly). */
async function pickAccount(job: Job, running: Map<string, number>, startedThisTick: Map<string, number>, now: number): Promise<{ account: Account; util: number } | null> {
  const candidates = job.account_id === "any" ? listAccounts() : ([accountById(job.account_id)].filter(Boolean) as Account[]);
  const usable: { account: Account; util: number }[] = [];
  for (const a of candidates) {
    const inUse = (running.get(a.id) ?? 0) + (startedThisTick.get(a.id) ?? 0);
    if (inUse >= CONCURRENCY) continue;
    if (!existsSync(a.credentialsPath)) continue;
    const paused = pausedUntil.get(a.id);
    if (paused && now < paused) continue;
    const u = await getUsage(a.id);
    // No reading → can't judge headroom. Rather than risk pushing an account we
    // can't see over its limit, skip it this tick.
    if (!u.available) continue;
    const util = Math.max(u.five_hour?.utilization ?? 0, u.seven_day?.utilization ?? 0);
    if (util >= CEILING) continue;
    usable.push({ account: a, util });
  }
  if (!usable.length) return null;
  usable.sort((x, y) => x.util - y.util);
  return usable[0];
}

/** Fire-and-forget: mark running, run, then record the outcome. The tick does
 *  not await this — a job runs for minutes and the loop must stay responsive. */
function dispatch(job: Job, account: Account): void {
  markRunning(job.id, account.id);
  execute(job, account)
    .then((out) => {
      if (out.rateLimited) {
        const until = out.resetAt ? Date.parse(out.resetAt) || Date.now() + 3_600_000 : Date.now() + 3_600_000;
        pausedUntil.set(account.id, until);
        requeueNoPenalty(job.id, `${account.id} rate-limited; paused until ${new Date(until).toISOString()}`);
        onEvent({ kind: "paused", account: account.id, until });
      } else if (out.ok) {
        markDone(job.id, out.session_id, out.summary);
        onEvent({ kind: "done", job, account: account.id, session_id: out.session_id });
      } else {
        const { retried } = failAttempt(job.id, out.error ?? "unknown error");
        if (!retried) onEvent({ kind: "failed", job, account: account.id, error: out.error ?? "unknown error" });
      }
    })
    .catch((e) => { failAttempt(job.id, e instanceof Error ? e.message : String(e)); });
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return; // a slow pick (usage fetch) must not let ticks stack
  ticking = true;
  try {
    const now = Date.now();
    resolveBlocked();
    expireStale(now);
    const running = runningCountByAccount();
    const startedThisTick = new Map<string, number>();
    for (const job of queuedJobs()) {
      if (!inWindow(job, now)) continue;
      const pick = await pickAccount(job, running, startedThisTick, now);
      if (!pick) continue;
      startedThisTick.set(pick.account.id, (startedThisTick.get(pick.account.id) ?? 0) + 1);
      dispatch(job, pick.account);
    }
  } catch (e) {
    console.error(`[dispatch] tick failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    ticking = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startDispatcher(): void {
  if (!DISPATCH_ENABLED) {
    console.log("⏸  dispatcher disabled (AGENTGLASS_DISPATCH_DISABLED=1 or no claude CLI)");
    return;
  }
  const recovered = recoverInterrupted();
  if (recovered) console.log(`[dispatch] requeued ${recovered} job(s) interrupted by a restart`);
  console.log(`🗒  dispatcher on — tick ${TICK_MS / 1000}s, ${CONCURRENCY}/account, queue ceiling ${CEILING}%`);
  timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
}
export function stopDispatcher(): void { if (timer) clearInterval(timer); timer = null; }
