// The job queue's validation, state machine and dependency logic — the pure
// parts that don't spawn `claude`. Driven against a throwaway DB with no
// accounts configured, so the registry synthesizes the default "work" account
// (the only id these tests need to be valid).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratch, scratchDir } from "./scratch.ts";

const dir = scratchDir(join(tmpdir(), "agx-queue-"));
process.env.AGENTGLASS_DB = join(dir, "queue.db");
process.env.XDG_CONFIG_HOME = dir; // empty config → registry synthesizes "work"

let q: typeof import("../src/queue.ts");
beforeAll(async () => { q = await import("../src/queue.ts"); });

// createJob only checks that cwd is a directory (the git/scope check lives in
// the executor), so the temp dir itself is a valid cwd.
const mk = (over: Partial<Parameters<typeof q.createJob>[0]> = {}) => q.createJob({ prompt: "do a thing", cwd: dir, ...over });
const id = (r: ReturnType<typeof q.createJob>) => (r.ok ? r.job.id : "");

describe("createJob validation", () => {
  test("requires a non-empty prompt", () => {
    expect(mk({ prompt: "   " }).ok).toBe(false);
  });
  test("requires an existing cwd directory", () => {
    expect(q.createJob({ prompt: "x", cwd: "/no/such/dir" }).ok).toBe(false);
    expect(mk().ok).toBe(true);
  });
  test("clamps priority and max_turns to their bounds", () => {
    const r = mk({ priority: 999, max_turns: 99_999 });
    expect(r.ok && r.job.priority).toBe(100);
    expect(r.ok && r.job.max_turns).toBe(200);
    const lo = mk({ priority: -5, max_turns: 0 });
    expect(lo.ok && lo.job.priority).toBe(0);
    expect(lo.ok && lo.job.max_turns).toBe(1);
  });
  test("rejects an inverted time window", () => {
    expect(mk({ window_start: 200, window_end: 100 }).ok).toBe(false);
  });
  test("rejects an unknown account; accepts 'any' and the default", () => {
    expect(mk({ account_id: "nope" }).ok).toBe(false);
    expect(mk({ account_id: "any" }).ok).toBe(true);
    expect(mk({ account_id: "work" }).ok).toBe(true);
  });
});

describe("state machine", () => {
  test("queued → running → done, linking the session", () => {
    const r = mk({ max_attempts: 2 });
    expect(q.getJob(id(r))?.status).toBe("queued");
    q.markRunning(id(r), "work");
    let j = q.getJob(id(r))!;
    expect(j.status).toBe("running");
    expect(j.attempts).toBe(1);
    expect(j.account_used).toBe("work");
    q.markDone(id(r), "sess-1", "the result");
    j = q.getJob(id(r))!;
    expect(j.status).toBe("done");
    expect(j.result_session_id).toBe("sess-1");
    expect(j.result_summary).toBe("the result");
  });

  test("failAttempt retries while attempts remain, then fails at the cap", () => {
    const r = mk({ max_attempts: 2 });
    q.markRunning(id(r), "work"); // attempts → 1
    expect(q.failAttempt(id(r), "boom").retried).toBe(true);
    expect(q.getJob(id(r))?.status).toBe("queued");
    q.markRunning(id(r), "work"); // attempts → 2
    expect(q.failAttempt(id(r), "boom again").retried).toBe(false);
    expect(q.getJob(id(r))?.status).toBe("failed");
  });

  test("requeueNoPenalty returns to queued without consuming an attempt", () => {
    const r = mk({ max_attempts: 3 });
    q.markRunning(id(r), "work"); // attempts → 1
    q.requeueNoPenalty(id(r), "rate limited");
    const j = q.getJob(id(r))!;
    expect(j.status).toBe("queued");
    expect(j.attempts).toBe(0);
  });

  test("markExpired retires a job", () => {
    const r = mk();
    q.markExpired(id(r));
    expect(q.getJob(id(r))?.status).toBe("expired");
  });
});

describe("dependencies", () => {
  test("blocked until every dep is done, then resolves to queued", () => {
    const a = mk({ prompt: "dep-a" });
    const b = mk({ prompt: "dep-b", depends_on: [id(a)] });
    expect(b.ok && b.job.status).toBe("blocked");
    q.resolveBlocked();
    expect(q.getJob(id(b))?.status).toBe("blocked"); // a not done yet
    q.markRunning(id(a), "work"); q.markDone(id(a), null, null);
    q.resolveBlocked();
    expect(q.getJob(id(b))?.status).toBe("queued");
  });

  test("a job whose dependency fails can never run — it fails too", () => {
    const a = mk({ prompt: "dead-a", max_attempts: 1 });
    const b = mk({ prompt: "dead-b", depends_on: [id(a)] });
    q.markRunning(id(a), "work");
    expect(q.failAttempt(id(a), "dead").retried).toBe(false); // a → failed
    q.resolveBlocked();
    expect(q.getJob(id(b))?.status).toBe("failed");
  });
});

describe("cancel", () => {
  test("cancels a queued job but refuses a running one", () => {
    const r = mk();
    expect(q.cancelJob(id(r)).ok).toBe(true);
    expect(q.getJob(id(r))?.status).toBe("cancelled");
    const r2 = mk();
    q.markRunning(id(r2), "work");
    expect(q.cancelJob(id(r2)).ok).toBe(false);
  });
});

describe("batch import", () => {
  test("reports a per-item result, rejecting bad items without failing the rest", () => {
    const res = q.createJobs([
      { prompt: "ok-1", cwd: dir },
      { prompt: "", cwd: dir },                         // no prompt
      { prompt: "bad-acct", cwd: dir, account_id: "nope" },
    ]);
    expect(res.created).toBe(1);
    expect(res.results.map((r) => r.ok)).toEqual([true, false, false]);
  });
});

describe("restart recovery", () => {
  test("recoverInterrupted requeues jobs left running", () => {
    const r = mk();
    q.markRunning(id(r), "work");
    expect(q.recoverInterrupted()).toBeGreaterThanOrEqual(1);
    expect(q.getJob(id(r))?.status).toBe("queued");
  });
});

afterAll(removeScratch);
