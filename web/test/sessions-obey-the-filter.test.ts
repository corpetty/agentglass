/*
 * The Sessions timeline follows every filter the dashboard offers.
 *
 * It took the provider and the host but asked the server for `account:
 * undefined`, so picking an account narrowed the feed and the stats and left
 * this list as it was. On a hub that is where it showed: one machine's
 * sessions under a second login sat among every machine's, and the ones older
 * than the forty most recent could not be reached by any filter here.
 *
 * Asserted against the source: there is no DOM in these suites, so no effect
 * ever runs.
 */
import { describe, expect, test } from "bun:test";

const SESSIONS = await Bun.file(new URL("../src/components/Sessions.tsx", import.meta.url)).text();
const DASHBOARD = await Bun.file(new URL("../src/components/DashboardView.tsx", import.meta.url)).text();

describe("the Sessions timeline and the dashboard filter", () => {
  test("the dashboard hands it the account, as it does the provider and host", () => {
    const tag = DASHBOARD.match(/<Sessions\b[^>]*\/>/);
    expect(tag).not.toBeNull();
    for (const prop of ["provider={filter.provider}", "account={filter.account}", "host={filter.host}"]) {
      expect(tag![0]).toContain(prop);
    }
  });

  test("it asks the server for that account, and asks again when it changes", () => {
    const call = SESSIONS.match(/api\.sessions\(([^)]*)\)/);
    expect(call).not.toBeNull();
    const args = call![1].split(",").map((a) => a.trim());
    // (limit, provider, account, host) — the third is the account.
    expect(args[2]).toBe("account || undefined");
    // The effect is one line, and its body holds a `;` of its own.
    const deps = SESSIONS.match(/useEffect\(.*\},\s*\[([^\]]*)\]\);/);
    expect(deps).not.toBeNull();
    expect(deps![1].split(",").map((d) => d.trim())).toContain("account");
  });
});
