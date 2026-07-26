// Account usage: fetches the 5-hour + weekly rate-limit windows from Anthropic's
// OAuth usage endpoint using each account's local Claude Code credentials.
// Localhost-only — a token never leaves this machine except to api.anthropic.com
// (its purpose).
//
// One reading per account, keyed by account id and cached independently, so the
// dashboard can show every subscription's headroom at once. The default account
// preserves the exact single-account behavior this module started with.
//
// This uses an unofficial endpoint (the one Claude Code's `/usage` calls). It may
// change; failures degrade gracefully to { available: false }.
import { accountById, defaultAccount, listAccounts, type Account } from "./accounts.ts";
import { accessToken } from "./oauth.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageWindow {
  utilization: number; // 0..100 used
  remaining: number; // 0..100 left
  resets_at: string | null;
}
export interface UsagePayload {
  available: boolean;
  /** Which account this reading is for (absent on the legacy single-account
   *  shape, present once resolved through the registry). */
  account?: string;
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  /** Per-model weekly buckets — only populated on Max plans. */
  seven_day_opus?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
  fetched_at: number;
  error?: string;
  /** Coarse failure kind so the UI can say "re-login" vs "rate-limited" vs a
   *  transient blip. */
  reason?: "no_credentials" | "unauthorized" | "rate_limited" | "error";
}

interface Slot {
  cache: UsagePayload | null;
  cacheAt: number;
  lastGood: UsagePayload | null;
}
const slots = new Map<string, Slot>();
const slotFor = (id: string): Slot =>
  slots.get(id) ?? (slots.set(id, { cache: null, cacheAt: 0, lastGood: null }), slots.get(id)!);

const TTL = 60_000;
// On failure, retry sooner and keep serving the last good reading
// (stale-while-error) so the UI meters never flicker out on a blip.
const ERROR_TTL = 10_000;
// A 429 means we're the ones being throttled — back off harder so polling every
// account doesn't dig the hole deeper.
const RATE_LIMIT_TTL = 5 * 60_000;
const STALE_MAX = 30 * 60_000; // stop serving stale data after 30m

// The usage endpoint keys off a Claude-Code-shaped User-Agent. Detect the
// locally-installed version once (best effort); override with AGENTGLASS_USAGE_UA.
let uaCache: string | null = null;
function userAgent(): string {
  if (uaCache) return uaCache;
  const override = process.env.AGENTGLASS_USAGE_UA;
  if (override) return (uaCache = override);
  try {
    const p = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    const m = p.stdout.toString().match(/(\d+\.\d+\.\d+)/);
    uaCache = m ? `claude-code/${m[1]}` : "claude-code/latest";
  } catch {
    uaCache = "claude-code/latest";
  }
  return uaCache;
}

function fetchUsage(t: string): Promise<Response> {
  return fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${t}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": userAgent(),
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

/** Fetch (or serve cached) usage for one resolved account. */
async function usageForAccount(acct: Account): Promise<UsagePayload> {
  const slot = slotFor(acct.id);
  const now = Date.now();
  const ttl =
    slot.cache?.available ? TTL : slot.cache?.reason === "rate_limited" ? RATE_LIMIT_TTL : ERROR_TTL;
  if (slot.cache && now - slot.cacheAt < ttl) return slot.cache;

  // Refreshes first if the stored token is expired (see oauth.ts).
  let t = await accessToken(acct.credentialsPath);
  if (!t) {
    slot.cache = degrade(slot, now, acct.id, "no credentials", "no_credentials");
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
      const reason = r.status === 401 ? "unauthorized" : r.status === 429 ? "rate_limited" : "error";
      slot.cache = degrade(slot, now, acct.id, `HTTP ${r.status}`, reason);
      slot.cacheAt = now;
      return slot.cache;
    }
    const j = (await r.json()) as any;
    slot.cache = {
      available: true,
      account: acct.id,
      five_hour: win(j.five_hour),
      seven_day: win(j.seven_day),
      seven_day_opus: win(j.seven_day_opus),
      seven_day_sonnet: win(j.seven_day_sonnet),
      fetched_at: now,
    };
    slot.lastGood = slot.cache;
  } catch (e) {
    slot.cache = degrade(slot, now, acct.id, String(e), "error");
  }
  slot.cacheAt = now;
  return slot.cache;
}

/** On failure, fall back to the last good reading (marked with its original
 *  fetched_at) instead of hiding the meters; only report unavailable when the
 *  stale data is too old to be meaningful. */
function degrade(
  slot: Slot,
  now: number,
  account: string,
  error: string,
  reason: UsagePayload["reason"]
): UsagePayload {
  if (slot.lastGood && now - slot.lastGood.fetched_at < STALE_MAX) {
    return { ...slot.lastGood, error, reason };
  }
  return { available: false, account, fetched_at: now, error, reason };
}

/** Usage for one account (default account when `accountId` is omitted). Keeps
 *  the legacy single-account call shape working. */
export async function getUsage(accountId?: string): Promise<UsagePayload> {
  const acct = accountId ? accountById(accountId) : defaultAccount();
  if (!acct) {
    return { available: false, account: accountId, fetched_at: Date.now(), error: "unknown account", reason: "error" };
  }
  return usageForAccount(acct);
}

/** Usage for every registered account, in registry order. */
export async function getAllUsage(): Promise<UsagePayload[]> {
  return Promise.all(listAccounts().map(usageForAccount));
}
