// Keep an account's Claude OAuth access token fresh.
//
// The usage meter needs a non-expired access token. Claude Code refreshes it on
// use, but an account the harness only *watches* (never runs interactively) goes
// stale and its meter 401s. This module does the same refresh Claude Code does —
// same endpoint, client id, and stored-credential shape — so a watched account's
// meter keeps working without a human running a command under it.
//
// The write mirrors Claude Code's: replace `claudeAiOauth` in the JSON, keep any
// other keys, write atomically at 0600. Disable with AGENTGLASS_TOKEN_REFRESH=0.

import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";

// Constants lifted verbatim from Claude Code's own bundle — whatever it uses is
// exactly what these stored credentials were minted against.
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_SCOPES = ["user:profile", "user:sessions:claude_code", "user:mcp_servers"];

// Refresh this many ms before the token actually expires, so a poll landing
// right at the boundary still gets a valid token.
const SKEW_MS = 60_000;

const ENABLED = process.env.AGENTGLASS_TOKEN_REFRESH !== "0";

interface OAuthCreds {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // ms epoch
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  [k: string]: unknown;
}

function readFile(path: string): { root: Record<string, unknown>; oauth: OAuthCreds } | null {
  try {
    const root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const oauth = (root.claudeAiOauth ?? {}) as OAuthCreds;
    return { root, oauth };
  } catch {
    return null;
  }
}

// Atomic + 0600: write a sibling temp file, then rename over the original, so a
// reader never sees a half-written credentials file and the token stays private.
function writeCreds(path: string, root: Record<string, unknown>, oauth: OAuthCreds): void {
  const next = { ...root, claudeAiOauth: oauth };
  const tmp = `${path}.agentglass.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function isExpired(oauth: OAuthCreds): boolean {
  // No expiry recorded → treat as fresh (let the API be the judge).
  return typeof oauth.expiresAt === "number" && Date.now() >= oauth.expiresAt - SKEW_MS;
}

// One in-flight refresh per credentials path — concurrent pollers share it
// instead of racing (and each racing refresh would rotate the token out from
// under the others).
const inFlight = new Map<string, Promise<string | null>>();

async function doRefresh(path: string): Promise<string | null> {
  // Re-read immediately before refreshing: a live Claude Code process may have
  // rotated the refresh token since we last looked, and using a spent one fails.
  const cur = readFile(path);
  const oauth = cur?.oauth;
  if (!oauth?.refreshToken) return oauth?.accessToken ?? null;

  const body = {
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: CLIENT_ID,
    scope: (oauth.scopes?.length ? oauth.scopes : DEFAULT_SCOPES).join(" "),
  };
  try {
    const r = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      // The refresh token was likely already rotated by another client — re-read
      // in case that client just wrote a fresh access token we can use as-is.
      const after = readFile(path)?.oauth;
      if (after?.accessToken && after.accessToken !== oauth.accessToken) return after.accessToken;
      console.error(`[oauth] refresh failed for ${path}: HTTP ${r.status}`);
      return oauth.accessToken ?? null;
    }
    const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    const next: OAuthCreds = {
      ...oauth,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? oauth.refreshToken,
      expiresAt: Date.now() + j.expires_in * 1000,
      scopes: j.scope ? j.scope.split(" ") : oauth.scopes,
      // subscriptionType / rateLimitTier come from a separate profile call in
      // Claude Code — preserve whatever's already stored rather than dropping it.
    };
    writeCreds(path, cur!.root, next);
    console.log(`[oauth] refreshed access token for ${path}`);
    return next.accessToken!;
  } catch (e) {
    console.error(`[oauth] refresh error for ${path}: ${e instanceof Error ? e.message : e}`);
    return oauth.accessToken ?? null;
  }
}

/**
 * Return a usable access token for the account at `credentialsPath`, refreshing
 * first when the stored one is expired (or when `force` is set, e.g. after a
 * 401). Returns null when there are no credentials at all. On any refresh
 * failure it falls back to the stored token so the caller can still try — and
 * surface a real `unauthorized` if that's also dead.
 */
export async function accessToken(credentialsPath: string, opts: { force?: boolean } = {}): Promise<string | null> {
  const cur = readFile(credentialsPath);
  if (!cur) return null;
  const oauth = cur.oauth;
  if (!oauth.accessToken && !oauth.refreshToken) return null;

  const needsRefresh = ENABLED && oauth.refreshToken && (opts.force || isExpired(oauth));
  if (!needsRefresh) return oauth.accessToken ?? null;

  let p = inFlight.get(credentialsPath);
  if (!p) {
    p = doRefresh(credentialsPath).finally(() => inFlight.delete(credentialsPath));
    inFlight.set(credentialsPath, p);
  }
  return p;
}
