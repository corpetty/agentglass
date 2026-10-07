import { useEffect, useState } from "react";
import { api } from "./api.ts";

/**
 * The name the server this window talks to goes by (docs/FLEET.md).
 *
 * Rows already carry a host, labelled by the server; this is the one name
 * among them that means "here" — the machine a Resume would start a process
 * on. Asked once per page and shared: it changes only when the server is
 * renamed, which a reload covers. Null until known, and on a server too old to
 * say, so callers treat "unknown" as "offer what they always offered".
 */
let cached: Promise<string | null> | null = null;

export function serverHost(): Promise<string | null> {
  cached ??= api.fleetStatus().then((s) => s.host ?? null).catch(() => {
    cached = null; // try again next time rather than remember a failure
    return null;
  });
  return cached;
}

export function useServerHost(): string | null {
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    serverHost().then((h) => { if (live) setHost(h); });
    return () => { live = false; };
  }, []);
  return host;
}

/** A row that ran somewhere other than the server this window talks to. */
export function ranElsewhere(rowHost: string | null | undefined, here: string | null): boolean {
  return !!rowHost && !!here && rowHost !== here;
}
