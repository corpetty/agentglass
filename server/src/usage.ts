// Account usage: fetches the 5-hour + weekly rate-limit windows from Anthropic's
// OAuth usage endpoint using each account's local Claude Code credentials.
// Localhost-only — a token never leaves this machine except to api.anthropic.com
// (its purpose).
//
// One reading per account, keyed by account id and cached (with its own backoff)
// independently, so the dashboard can show every subscription's headroom at once.
// The default account also gets the statusline fast-path below, same as upstream's
// original single-account behavior. An expired token is refreshed first (see
// oauth.ts) so a watched-only, idle account keeps reporting without a human
// running a command under it.
//
// This uses an unofficial endpoint (the one Claude Code's `/usage` calls). It may
// change; failures degrade gracefully to { available: false }.
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { accountById, defaultAccount, listAccounts, type Account } from "./accounts.ts";
import { accessToken } from "./oauth.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageWindow {
  utilization: number; // 0..100 used
  remaining: number; // 0..100 left
  resets_at: string | null;
}
/**
 * A weekly window that applies to one model rather than to everything — the
 * "Fable" bar, today.
 *
 * Named rather than keyed, because the name is the server's to choose: it
 * arrives as a `display_name` on both sources, and the plan that has one bucket
 * this week can have another next week. Reading them generically means a new
 * model appears on its own instead of waiting for a release here.
 */
export interface UsageScopedWindow extends UsageWindow {
  name: string;
}

export interface UsagePayload {
  available: boolean;
  /** Which account this reading is for (present once resolved through the
   *  registry; absent only on the earliest / legacy single-account shape). */
  account?: string;
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  /** Per-model weekly windows, in the order the API listed them. */
  scoped?: UsageScopedWindow[];
  /** The same two, flattened by name for the panels that still ask for them by
   *  model rather than iterating `scoped`. Derived, never fetched twice. */
  seven_day_opus?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  fetched_at: number;
  error?: string;
  /** Coarse failure kind so the UI can say "re-login" vs "rate-limited" vs a
   *  transient blip. */
  reason?: "no_credentials" | "unauthorized" | "rate_limited" | "error";
}

/*
 * Fifteen minutes, and this is the only cadence that reaches Anthropic — the
 * browser polls this server, which costs nothing and is why it can stay quick.
 *
 * The endpoint limits per account and limits hard: measured on one machine,
 * three calls inside four minutes was enough to be answered 429, with every
 * Claude Code session open at the time drawing on the same budget. What is
 * being asked about is a five-hour window and a seven-day one, so a
 * fifteen-minute picture of them is the same picture. A shorter TTL buys no
 * accuracy — it buys a larger share of a budget that isn't ours to spend.
 */
const TTL = 15 * 60_000;
/**
 * How long the endpoint may go unasked while a live session keeps the meters
 * fed. See the use site: a feed cannot postpone the poll past this, because
 * only the poll can see the per-model windows.
 */
const POLL_FLOOR = 60 * 60_000;
// On failure, retry sooner than the happy path — but back off, because the
// most common failure here is a 429 and retrying every ten seconds against a
// rate limiter is what *keeps* you rate-limited. Doubling from 10s to a 5m
// ceiling turns a self-inflicted outage into a blip.
const ERROR_TTL = 10_000;
const ERROR_TTL_MAX = 5 * 60_000;
/**
 * How long a good reading stays worth showing once fetching starts failing.
 *
 * Half an hour for an ordinary failure. A full day when the failure is a 429,
 * because a 429 from this endpoint is not an outage — it is a busy Tuesday. The
 * limit is per account and shared with every Claude Code session on the
 * machine, so throttling arrives in bursts all day while the numbers being
 * throttled barely move. Expiring the reading after half an hour swapped two
 * true, slightly old percentages for the word "Rate-limited", which is the one
 * thing that strip can say that tells you nothing at all about your plan.
 */
const STALE_MAX = 30 * 60_000;
const RATE_LIMITED_STALE_MAX = 24 * 3_600_000;

/** Exported for the test that would otherwise have to wait a day to run. */
export const staleWindowFor = (status: number | null): number =>
  status === 429 ? RATE_LIMITED_STALE_MAX : STALE_MAX;

// Per-account cache + backoff state, keyed by account id. Independent per
// account: the endpoint's rate limit is per token, so one account's 429s must
// never throttle another's polling.
interface Slot {
  cache: UsagePayload | null;
  cacheAt: number;
  lastGood: UsagePayload | null;
  failures: number;
  /** Honour an explicit Retry-After over our own guess — the server knows. */
  retryAfterMs: number;
  /** When the network was last actually attempted — distinct from `cacheAt`,
   *  which a free (statusline) reading also moves. */
  lastFetchAt: number;
}
const slots = new Map<string, Slot>();
const slotFor = (id: string): Slot => {
  let s = slots.get(id);
  if (!s) slots.set(id, (s = { cache: null, cacheAt: 0, lastGood: null, failures: 0, retryAfterMs: 0, lastFetchAt: 0 }));
  return s;
};

/**
 * The last good reading for one account, kept on disk between runs.
 *
 * Holding it only in memory made the day-long window above worth nothing in
 * practice: the reading dies with the process, and this process is restarted
 * every time the desktop app is rebuilt or relaunched. A fresh process starting
 * blind into a burst of 429s has nothing to show and no way to get anything,
 * which is the exact hole the grace window was supposed to close.
 *
 * One file per account (the default account keeps the original filename, so an
 * existing single-account install's reading survives the upgrade).
 */
function lastGoodPath(accountId: string): string {
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass");
  const isDefault = accountId === defaultAccount().id;
  return join(dir, isDefault ? "usage-last.json" : `usage-last-${accountId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/** Under `bun test`, only a scratch directory may be touched — the same rule
 *  config.ts applies, so no suite reads or overwrites a real reading. Asked per
 *  call for the reason `configPath()` gives: the answer depends on an
 *  environment a test sets before its own import, and import order is not ours
 *  to choose. */
function offLimits(): boolean {
  return process.env.NODE_ENV === "test"
    && !(process.env.XDG_CONFIG_HOME ?? "").startsWith(tmpdir());
}

const restoredIds = new Set<string>();
/** Read once per account per process, and only to seed `lastGood` — never to
 *  answer a request directly. What comes back is subject to the same staleness
 *  rules as a reading this process took itself; a file from last week is as
 *  dead as a memory from last week. */
async function restoreLastGood(accountId: string, slot: Slot): Promise<void> {
  if (restoredIds.has(accountId)) return;
  restoredIds.add(accountId);
  if (offLimits()) return;
  try {
    const j = (await Bun.file(lastGoodPath(accountId)).json()) as UsagePayload;
    // Anything hand-edited or half-written is simply not a reading.
    if (j?.available === true && typeof j.fetched_at === "number" && (j.five_hour || j.seven_day)) {
      slot.lastGood = {
        available: true, account: accountId, five_hour: j.five_hour, seven_day: j.seven_day,
        // Rebuilt field by field rather than spread, so a file written by a
        // future version cannot smuggle keys into the payload we serve.
        scoped: Array.isArray(j.scoped) ? j.scoped : undefined,
        fetched_at: j.fetched_at,
      };
    }
  } catch { /* no file yet, or nonsense in it: start blind, as before. */ }
}

/** Fire and forget. A reading that fails to persist is worth less on the next
 *  boot, which is not worth failing a request over. */
function persistLastGood(accountId: string, u: UsagePayload): void {
  if (offLimits()) return;
  Bun.write(lastGoodPath(accountId), JSON.stringify(u)).catch(() => {});
}

/**
 * Everything a restart takes with it, for every account.
 *
 * Exported for the test that has to simulate one: the whole point of the file
 * on disk is what happens across a boundary a single process cannot otherwise
 * cross, and "restart the server" is not something a unit test can do.
 */
export function __test_forgetEverything(): void {
  slots.clear();
  restoredIds.clear();
}

/** Carries the status through the throw, so a failure is classified from what
 *  the server said rather than pattern-matched back out of a message. */
class UsageHttpError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

function fetchUsage(t: string): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${t}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "agentglass",
    },
    signal: AbortSignal.timeout(8000),
  });
}

function win(w: any): UsageWindow | undefined {
  if (!w || typeof w.utilization !== "number") return undefined;
  return {
    utilization: Math.round(w.utilization),
    remaining: Math.max(0, Math.round(100 - w.utilization)),
    resets_at: w.resets_at ?? null,
  };
}

/** Shared by both sources: a percentage that has to end up on a bar. */
function scopedOf(name: unknown, percent: unknown, resets: unknown): UsageScopedWindow | null {
  if (typeof name !== "string" || !name.trim()) return null;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  const used = Math.round(Math.min(100, Math.max(0, percent)));
  return { name: name.trim(), utilization: used, remaining: 100 - used, resets_at: statuslineReset(resets) };
}

/**
 * The per-model windows out of the usage endpoint's `limits` array.
 *
 * They used to be flat fields — `seven_day_opus` and friends, still derived
 * below for the panels that read them that way. The live ones moved into
 * `limits`, where a per-model entry is `kind: "weekly_scoped"` and carries its
 * name under `scope.model.display_name`.
 *
 * `is_active` is NOT a validity flag and must not be filtered on: it marks
 * which limit is currently the binding one — `weekly_all`, usually — so the
 * Fable entry is routinely inactive while carrying a perfectly real percent.
 */
function scopedFromLimits(limits: unknown): UsageScopedWindow[] | undefined {
  if (!Array.isArray(limits)) return undefined;
  const out: UsageScopedWindow[] = [];
  for (const l of limits) {
    if (!l || typeof l !== "object" || (l as any).kind !== "weekly_scoped") continue;
    const w = scopedOf((l as any).scope?.model?.display_name, (l as any).percent, (l as any).resets_at);
    if (w) out.push(w);
  }
  return out.length ? out : undefined;
}

/**
 * The same windows off a statusline payload, where the CLI has already done the
 * work: `rate_limits.model_scoped` is a flat list of `{ display_name,
 * utilization, resets_at }`, with the reset time converted to a string on the
 * way out. A different shape for the same thing, so both are read here rather
 * than one being made to look like the other somewhere upstream.
 */
function scopedFromModelScoped(list: unknown): UsageScopedWindow[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: UsageScopedWindow[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const w = scopedOf((m as any).display_name, (m as any).utilization, (m as any).resets_at);
    if (w) out.push(w);
  }
  return out.length ? out : undefined;
}

/**
 * When a window resets, however the CLI chose to say it.
 *
 * Seconds since the epoch is what it sends today; a string is accepted so a
 * schema change degrades to a missing reset time rather than to a date in
 * 1970 or in the year 58,000. A number that is plainly milliseconds is read as
 * milliseconds for the same reason — guessing wrong here puts "resets in 45
 * years" on a status strip.
 */
function statuslineReset(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** One window out of a statusline payload. `used_percentage` is what the CLI
 *  sends; `utilization` is accepted as the usage endpoint's name for the same
 *  number, so one schema drifting toward the other costs nothing. */
function statuslineWindow(w: any): UsageWindow | undefined {
  if (!w || typeof w !== "object") return undefined;
  const raw = typeof w.used_percentage === "number" ? w.used_percentage
    : typeof w.utilization === "number" ? w.utilization
    : null;
  if (raw === null || !Number.isFinite(raw)) return undefined;
  const used = Math.round(Math.min(100, Math.max(0, raw)));
  return { utilization: used, remaining: 100 - used, resets_at: statuslineReset(w.resets_at) };
}

/**
 * The per-model windows a statusline payload does not carry, kept from the last
 * reading that did.
 *
 * Captured from a live session: the CLI sends `rate_limits` with `five_hour`
 * and `seven_day` and nothing else, while the usage endpoint reports a scoped
 * weekly window for the same account in the same minute. So the free feed is
 * the *fresher* source and the poll is the *fuller* one, and since accepting a
 * feed postpones the poll by a TTL, letting an ingest blank the scoped windows
 * means the bar they draw would essentially never appear.
 */
function carriedScoped(slot: Slot, now: number): UsageScopedWindow[] | undefined {
  const prev = slot.lastGood;
  if (!prev?.scoped?.length) return undefined;
  return now - prev.fetched_at < RATE_LIMITED_STALE_MAX ? prev.scoped : undefined;
}

/** Flatten `scoped` back onto the two legacy fields, by name — the shape the
 *  panel still asks for by model rather than iterating a list. */
function withLegacyScoped(u: UsagePayload): UsagePayload {
  if (!u.scoped?.length) return u;
  const opus = u.scoped.find((w) => /opus/i.test(w.name));
  const sonnet = u.scoped.find((w) => /sonnet/i.test(w.name));
  if (!opus && !sonnet) return u;
  return { ...u, seven_day_opus: opus, seven_day_sonnet: sonnet };
}

/**
 * A reading handed over by a live Claude Code session instead of fetched.
 *
 * Claude Code pipes `rate_limits` to its statusLine command on every turn,
 * carried on the Messages API response it already made — the same account-wide
 * numbers this module otherwise pays the usage endpoint for, for free. That
 * makes this the preferred source and the poll above the fallback, which is the
 * point: the endpoint is tight enough to answer 429 to a third call inside four
 * minutes, and a machine running agents all day is asking it constantly.
 *
 * Scoped to the default account: the payload carries no account id of its own
 * (the statusline command runs under whichever login the local session used),
 * and the default account — the plain `~/.claude` login — is what that is in
 * the common case. A statusline from a secondary account's session still costs
 * that account nothing; it simply keeps polling on its own schedule below.
 *
 * `failures` is deliberately left alone. It tracks how the endpoint has been
 * treating us, and a session handing us numbers says nothing about that —
 * resetting the backoff here would send us back at it every ten seconds the
 * moment the sessions went quiet.
 */
export function ingestStatusline(raw: unknown, now: number = Date.now()): boolean {
  const rl = (raw as any)?.rate_limits;
  if (!rl || typeof rl !== "object") return false;
  const five_hour = statuslineWindow(rl.five_hour);
  const seven_day = statuslineWindow(rl.seven_day);
  // Neither window readable is not a reading. Saying so lets the route answer
  // honestly rather than reporting a success that changed nothing.
  if (!five_hour && !seven_day) return false;

  const acct = defaultAccount();
  const slot = slotFor(acct.id);
  const next: UsagePayload = withLegacyScoped({
    available: true, account: acct.id, five_hour, seven_day,
    scoped: scopedFromModelScoped(rl.model_scoped) ?? carriedScoped(slot, now),
    fetched_at: now,
  });
  slot.cache = next;
  slot.cacheAt = now;
  slot.lastGood = next;
  persistLastGood(acct.id, next);
  return true;
}

/** On failure, fall back to the last good reading (marked with its original
 *  fetched_at) instead of hiding the meters; only report unavailable when the
 *  stale data is too old to be meaningful — which depends on why the fetch
 *  failed, see `staleWindowFor`. The error travels with the stale payload so
 *  the client can say how old the numbers are rather than implying they are
 *  live. */
function degrade(slot: Slot, now: number, accountId: string, error: string, reason: UsagePayload["reason"], status: number | null): UsagePayload {
  if (slot.lastGood && now - slot.lastGood.fetched_at < staleWindowFor(status)) {
    return { ...slot.lastGood, error, reason };
  }
  return { available: false, account: accountId, fetched_at: now, error, reason };
}

/** Fetch (or serve cached) usage for one resolved account. */
async function usageForAccount(acct: Account, now: number = Date.now()): Promise<UsagePayload> {
  const slot = slotFor(acct.id);
  // Before the first attempt, so a process that boots into a burst of 429s
  // still has yesterday's answer rather than no answer.
  await restoreLastGood(acct.id, slot);

  const backoff = Math.max(
    slot.retryAfterMs,
    Math.min(ERROR_TTL_MAX, ERROR_TTL * 2 ** Math.max(0, slot.failures - 1)),
  );
  const ttl = slot.cache?.available ? TTL : backoff;
  // The feed is the fresher source and the poll is the fuller one, so the poll
  // gets a floor of its own that a feed cannot push out. Without it, a session
  // posting every fifteen seconds moves `cacheAt` forward forever and the
  // endpoint is never asked again — which is fine for the two windows the feed
  // carries and fatal for the scoped ones it does not. Only the floor, with no
  // backoff clause: `lastFetchAt` is stamped on the attempt, so a failing
  // endpoint gets one extra try an hour out of this and not one per caller.
  const overdue = now - slot.lastFetchAt >= POLL_FLOOR;
  if (slot.cache && now - slot.cacheAt < ttl && !overdue) return slot.cache;

  // Stamped on the attempt, not on success: a run of 429s must not have the
  // floor firing at every caller on the way past.
  slot.lastFetchAt = now;

  // Refreshes first if the stored token is expired (see oauth.ts).
  let t = await accessToken(acct.credentialsPath);
  if (!t) {
    slot.cache = degrade(slot, now, acct.id, "no credentials", "no_credentials", null);
    slot.cacheAt = now;
    return slot.cache;
  }
  try {
    let r = await fetchUsage(t);
    // A 401 despite a token we believed valid → force one refresh and retry.
    if (r.status === 401) {
      const fresh = await accessToken(acct.credentialsPath, { force: true });
      if (fresh && fresh !== t) { t = fresh; r = await fetchUsage(t); }
    }
    if (!r.ok) {
      // A 429 usually carries how long to wait. Believing it beats guessing,
      // and ignoring it is how a client earns a longer ban.
      const ra = Number(r.headers.get("retry-after"));
      slot.retryAfterMs = r.status === 429 && Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, ERROR_TTL_MAX) : 0;
      throw new UsageHttpError(r.status);
    }
    const j = (await r.json()) as any;
    slot.cache = withLegacyScoped({
      available: true,
      account: acct.id,
      five_hour: win(j.five_hour),
      seven_day: win(j.seven_day),
      scoped: scopedFromLimits(j.limits),
      fetched_at: now,
    });
    slot.lastGood = slot.cache;
    persistLastGood(acct.id, slot.cache);
    slot.failures = 0;
    slot.retryAfterMs = 0;
  } catch (e) {
    slot.failures++;
    const status = e instanceof UsageHttpError ? e.status : null;
    const reason = status === 401 ? "unauthorized" : status === 429 ? "rate_limited" : "error";
    slot.cache = degrade(slot, now, acct.id, String(e), reason, status);
  }
  slot.cacheAt = now;
  return slot.cache;
}

/**
 * Usage for the default account — the plain `~/.claude` login, or the first
 * configured account when none uses it. This is the single-account call shape
 * upstream's own tests pin exactly (including the unsuffixed `usage-last.json`
 * on disk), so it keeps that contract rather than growing an account
 * parameter here.
 * @param now Injected clock in tests — every decision here is a function of
 *   time, and a day-long window is not something a test can wait for.
 */
export async function getUsage(now: number = Date.now()): Promise<UsagePayload> {
  return usageForAccount(defaultAccount(), now);
}

/** Usage for one *specific* account. Used by the Accounts panel, which asks
 *  by id rather than always meaning "the default login". */
export async function getAccountUsage(accountId: string, now: number = Date.now()): Promise<UsagePayload> {
  const acct = accountById(accountId);
  if (!acct) {
    return { available: false, account: accountId, fetched_at: now, error: "unknown account", reason: "error" };
  }
  return usageForAccount(acct, now);
}

/** Usage for every registered account, in registry order. */
export async function getAllUsage(now: number = Date.now()): Promise<UsagePayload[]> {
  return Promise.all(listAccounts().map((a) => usageForAccount(a, now)));
}
