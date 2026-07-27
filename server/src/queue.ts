// The job queue — persistence + CRUD for unattended `claude -p` work.
//
// A job is a prompt to run in a repo, under one of the configured accounts, with
// a mandatory turn cap and an optional time window. The dispatcher (dispatcher.ts)
// reads eligible jobs from here, runs them, and writes back the outcome; this
// module owns the tables and the state transitions, nothing about scheduling
// policy.

import { statSync } from "node:fs";
import { db } from "./db.ts";
import { allowList } from "./chat.ts";
import { accountById } from "./accounts.ts";
import type { Job, JobEvent, JobInput, JobStatus } from "../../shared/types.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  cwd TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  window_start INTEGER,
  window_end INTEGER,
  account_id TEXT NOT NULL DEFAULT 'any',
  model TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  max_turns INTEGER NOT NULL DEFAULT 20,
  depends_on TEXT NOT NULL DEFAULT '[]',
  max_attempts INTEGER NOT NULL DEFAULT 3,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued',
  account_used TEXT,
  result_session_id TEXT,
  result_summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, ts);
`);

const MODES = new Set(["default", "plan", "acceptEdits", "bypassPermissions"]);
const MAX_PROMPT = 100_000;
const MAX_TURNS_CAP = 200;
const TERMINAL: JobStatus[] = ["done", "failed", "expired", "cancelled"];
export const isTerminal = (s: JobStatus) => TERMINAL.includes(s);

// --- row <-> Job ------------------------------------------------------------

interface JobRow {
  id: string; prompt: string; cwd: string; priority: number;
  window_start: number | null; window_end: number | null;
  account_id: string; model: string | null; permission_mode: string;
  allowed_tools: string; max_turns: number; depends_on: string;
  max_attempts: number; attempts: number; status: string;
  account_used: string | null; result_session_id: string | null;
  result_summary: string | null; error: string | null;
  created_at: number; updated_at: number; started_at: number | null; ended_at: number | null;
}

function parseArr(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}

function toJob(r: JobRow): Job {
  return {
    ...r,
    status: r.status as JobStatus,
    allowed_tools: parseArr(r.allowed_tools),
    depends_on: parseArr(r.depends_on),
  };
}

// --- validation + create ----------------------------------------------------

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : def;
  return Math.max(lo, Math.min(hi, n));
}

/** Validate + insert a job. Returns the created row, or a reason it was rejected. */
export function createJob(input: JobInput): { ok: true; job: Job } | { ok: false; error: string } {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "prompt is required" };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: "prompt too long" };

  const cwd = typeof input.cwd === "string" ? input.cwd.trim() : "";
  if (!cwd) return { ok: false, error: "cwd is required" };
  try { if (!statSync(cwd).isDirectory()) return { ok: false, error: "cwd is not a directory" }; }
  catch { return { ok: false, error: "cwd does not exist" }; }

  const account_id = typeof input.account_id === "string" && input.account_id.trim() ? input.account_id.trim() : "any";
  if (account_id !== "any" && !accountById(account_id)) return { ok: false, error: `unknown account: ${account_id}` };

  const ws = input.window_start ?? null;
  const we = input.window_end ?? null;
  if (ws != null && typeof ws !== "number") return { ok: false, error: "window_start must be a timestamp" };
  if (we != null && typeof we !== "number") return { ok: false, error: "window_end must be a timestamp" };
  if (ws != null && we != null && ws >= we) return { ok: false, error: "window_start must be before window_end" };

  const permission_mode = typeof input.permission_mode === "string" && MODES.has(input.permission_mode) ? input.permission_mode : "default";
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  const depends_on = Array.isArray(input.depends_on) ? input.depends_on.filter((x): x is string => typeof x === "string").slice(0, 64) : [];

  const now = Date.now();
  const job: Job = {
    id: crypto.randomUUID(),
    prompt, cwd,
    priority: clampInt(input.priority, 50, 0, 100),
    window_start: ws, window_end: we,
    account_id, model, permission_mode,
    allowed_tools: allowList(input.allowed_tools),
    max_turns: clampInt(input.max_turns, 20, 1, MAX_TURNS_CAP),
    depends_on,
    max_attempts: clampInt(input.max_attempts, 3, 1, 10),
    attempts: 0,
    status: depends_on.length ? "blocked" : "queued",
    account_used: null, result_session_id: null, result_summary: null, error: null,
    created_at: now, updated_at: now, started_at: null, ended_at: null,
  };
  insertStmt.run({
    $id: job.id, $prompt: job.prompt, $cwd: job.cwd, $priority: job.priority,
    $ws: job.window_start, $we: job.window_end, $account_id: job.account_id,
    $model: job.model, $pm: job.permission_mode, $tools: JSON.stringify(job.allowed_tools),
    $max_turns: job.max_turns, $deps: JSON.stringify(job.depends_on), $max_attempts: job.max_attempts,
    $status: job.status, $created: now, $updated: now,
  });
  logJobEvent(job.id, "queued", job.status === "blocked" ? `blocked on ${depends_on.length} dep(s)` : null);
  return { ok: true, job };
}

/** Create many jobs at once (a predefined batch). Returns a per-item result in
 *  order; a bad item is rejected without stopping the rest. Capped so one POST
 *  can't enqueue an unbounded flood. */
export function createJobs(inputs: JobInput[]): { created: number; results: ({ ok: true; id: string } | { ok: false; error: string })[] } {
  const list = Array.isArray(inputs) ? inputs.slice(0, 500) : [];
  const results = list.map((input) => {
    const r = createJob(input);
    return r.ok ? { ok: true as const, id: r.job.id } : { ok: false as const, error: r.error };
  });
  return { created: results.filter((r) => r.ok).length, results };
}

const insertStmt = db.query(`
  INSERT INTO jobs (
    id, prompt, cwd, priority, window_start, window_end, account_id, model,
    permission_mode, allowed_tools, max_turns, depends_on, max_attempts, status,
    created_at, updated_at
  ) VALUES (
    $id, $prompt, $cwd, $priority, $ws, $we, $account_id, $model,
    $pm, $tools, $max_turns, $deps, $max_attempts, $status,
    $created, $updated
  )
`);

// --- reads ------------------------------------------------------------------

const allStmt = db.query<JobRow, []>(`SELECT * FROM jobs ORDER BY created_at DESC`);
const byIdStmt = db.query<JobRow, [string]>(`SELECT * FROM jobs WHERE id = ?`);
const queuedStmt = db.query<JobRow, []>(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC, created_at ASC`);
const byStatusStmt = db.query<JobRow, [string]>(`SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC`);

export function listJobs(): Job[] { return allStmt.all().map(toJob); }
export function getJob(id: string): Job | null { const r = byIdStmt.get(id); return r ? toJob(r) : null; }
export function queuedJobs(): Job[] { return queuedStmt.all().map(toJob); }
export function jobsByStatus(status: JobStatus): Job[] { return byStatusStmt.all(status).map(toJob); }

const jobEventsStmt = db.query<JobEvent, [string]>(`SELECT * FROM job_events WHERE job_id = ? ORDER BY ts ASC, id ASC`);
export function jobEvents(job_id: string): JobEvent[] { return jobEventsStmt.all(job_id); }

// --- writes / state transitions ---------------------------------------------

const logStmt = db.query(`INSERT INTO job_events (job_id, ts, kind, detail) VALUES ($job, $ts, $kind, $detail)`);
export function logJobEvent(job_id: string, kind: string, detail: string | null = null): void {
  logStmt.run({ $job: job_id, $ts: Date.now(), $kind: kind, $detail: detail });
}

const setStatusStmt = db.query(`UPDATE jobs SET status = $status, updated_at = $now WHERE id = $id`);

/** Editable fields via PATCH /jobs/:id — priority, window, account, and a
 *  cancel (status → cancelled). Nothing else is user-settable; the dispatcher
 *  owns the rest. */
export function updateJob(id: string, patch: Partial<Pick<Job, "priority" | "window_start" | "window_end" | "account_id" | "status">>):
  { ok: true; job: Job } | { ok: false; error: string } {
  const job = getJob(id);
  if (!job) return { ok: false, error: "no such job" };
  if (patch.status && patch.status !== "cancelled") return { ok: false, error: "only 'cancelled' may be set by hand" };
  if (patch.status === "cancelled") return cancelJob(id).ok ? { ok: true, job: getJob(id)! } : { ok: false, error: "cannot cancel" };
  if (isTerminal(job.status)) return { ok: false, error: `job is ${job.status}` };

  const priority = patch.priority != null ? clampInt(patch.priority, job.priority, 0, 100) : job.priority;
  const ws = patch.window_start !== undefined ? patch.window_start : job.window_start;
  const we = patch.window_end !== undefined ? patch.window_end : job.window_end;
  if (ws != null && we != null && ws >= we) return { ok: false, error: "window_start must be before window_end" };
  const account_id = patch.account_id ?? job.account_id;
  if (account_id !== "any" && !accountById(account_id)) return { ok: false, error: `unknown account: ${account_id}` };

  db.query(`UPDATE jobs SET priority=$p, window_start=$ws, window_end=$we, account_id=$a, updated_at=$now WHERE id=$id`)
    .run({ $p: priority, $ws: ws, $we: we, $a: account_id, $now: Date.now(), $id: id });
  return { ok: true, job: getJob(id)! };
}

/** Cancel a non-running, non-terminal job. A running job is left alone — its
 *  executor owns the live process; stopping mid-turn is a separate concern. */
export function cancelJob(id: string): { ok: boolean; error?: string } {
  const job = getJob(id);
  if (!job) return { ok: false, error: "no such job" };
  if (isTerminal(job.status)) return { ok: false, error: `job is already ${job.status}` };
  if (job.status === "running") return { ok: false, error: "job is running — let it finish or stop it from the session" };
  setStatusStmt.run({ $status: "cancelled", $now: Date.now(), $id: id });
  logJobEvent(id, "cancelled");
  return { ok: true };
}

// --- dispatcher-facing mutators ---------------------------------------------

export function markRunning(id: string, account_used: string): void {
  const now = Date.now();
  db.query(`UPDATE jobs SET status='running', account_used=$acct, attempts=attempts+1, started_at=COALESCE(started_at,$now), updated_at=$now WHERE id=$id`)
    .run({ $acct: account_used, $now: now, $id: id });
  logJobEvent(id, "started", `account ${account_used}`);
}

export function markDone(id: string, session_id: string | null, summary: string | null): void {
  const now = Date.now();
  db.query(`UPDATE jobs SET status='done', result_session_id=$sid, result_summary=$sum, ended_at=$now, updated_at=$now, error=NULL WHERE id=$id`)
    .run({ $sid: session_id, $sum: summary?.slice(0, 2000) ?? null, $now: now, $id: id });
  logJobEvent(id, "completed", session_id ? `session ${session_id}` : null);
}

/** Record a failed attempt. Back to 'queued' if attempts remain, else 'failed'.
 *  Returns whether the job will be retried. */
export function failAttempt(id: string, error: string): { retried: boolean } {
  const job = getJob(id);
  if (!job) return { retried: false };
  const now = Date.now();
  if (job.attempts < job.max_attempts) {
    db.query(`UPDATE jobs SET status='queued', error=$err, updated_at=$now WHERE id=$id`)
      .run({ $err: error.slice(0, 2000), $now: now, $id: id });
    logJobEvent(id, "requeued", `attempt ${job.attempts}/${job.max_attempts}: ${error}`.slice(0, 500));
    return { retried: true };
  }
  db.query(`UPDATE jobs SET status='failed', error=$err, ended_at=$now, updated_at=$now WHERE id=$id`)
    .run({ $err: error.slice(0, 2000), $now: now, $id: id });
  logJobEvent(id, "failed", error.slice(0, 500));
  return { retried: false };
}

/** Requeue without consuming an attempt — used when a rate-limit paused the
 *  account, which isn't the job's fault. */
export function requeueNoPenalty(id: string, reason: string): void {
  const now = Date.now();
  db.query(`UPDATE jobs SET status='queued', attempts=MAX(0,attempts-1), updated_at=$now WHERE id=$id`).run({ $now: now, $id: id });
  logJobEvent(id, "rate_limited", reason.slice(0, 500));
}

export function markExpired(id: string): void {
  const now = Date.now();
  db.query(`UPDATE jobs SET status='expired', ended_at=$now, updated_at=$now WHERE id=$id`).run({ $now: now, $id: id });
  logJobEvent(id, "expired");
}

/** blocked → queued once every dependency is done; blocked → failed if any
 *  dependency failed/expired/cancelled (it can never satisfy now). Called each
 *  tick before picking work. */
export function resolveBlocked(): void {
  for (const job of jobsByStatus("blocked")) {
    const deps = job.depends_on.map(getJob);
    if (deps.some((d) => d && (d.status === "failed" || d.status === "expired" || d.status === "cancelled"))) {
      db.query(`UPDATE jobs SET status='failed', error='a dependency did not complete', ended_at=$now, updated_at=$now WHERE id=$id`)
        .run({ $now: Date.now(), $id: job.id });
      logJobEvent(job.id, "failed", "dependency did not complete");
      continue;
    }
    if (deps.every((d) => d && d.status === "done")) {
      setStatusStmt.run({ $status: "queued", $now: Date.now(), $id: job.id });
      logJobEvent(job.id, "queued", "dependencies satisfied");
    }
  }
}

/** How many jobs are running right now, per account — the concurrency cap
 *  reads this. */
export function runningCountByAccount(): Map<string, number> {
  const rows = db.query<{ account_used: string; n: number }, []>(
    `SELECT account_used, COUNT(*) AS n FROM jobs WHERE status='running' AND account_used IS NOT NULL GROUP BY account_used`
  ).all();
  return new Map(rows.map((r) => [r.account_used, r.n]));
}

/** On boot, any job left 'running' was interrupted by a restart mid-flight (the
 *  executor process died with the server). Requeue it rather than leave a ghost
 *  that no executor owns. */
export function recoverInterrupted(): number {
  const rows = db.query<{ id: string }, []>(`SELECT id FROM jobs WHERE status='running'`).all();
  for (const r of rows) {
    db.query(`UPDATE jobs SET status='queued', updated_at=$now WHERE id=$id`).run({ $now: Date.now(), $id: r.id });
    logJobEvent(r.id, "requeued", "server restarted mid-run");
  }
  return rows.length;
}
