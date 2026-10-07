// A repository on another machine, named `@host:/path`, and the one place a
// request is redirected because of it (web/src/lib/remoteRoot.ts).
import { describe, expect, test } from "bun:test";
import { remoteRoot, remoteTarget, splitRemote, isRemoteRoot, relabel } from "../src/lib/remoteRoot.ts";

describe("naming a remote repository", () => {
  test("round-trips, and is never a local path", () => {
    expect(splitRemote(remoteRoot("rooter", "/home/u/proj"))).toEqual({ host: "rooter", path: "/home/u/proj" });
    expect(isRemoteRoot("/home/u/proj")).toBe(false);
    expect(isRemoteRoot("@rooter:relative")).toBe(false);
    expect(isRemoteRoot("@../etc:/x")).toBe(false);
  });
});

describe("where a request goes", () => {
  test("a local request stays local", () => {
    expect(remoteTarget("/git/log?root=%2Fhome%2Fu%2Fproj")).toBeNull();
    expect(remoteTarget("/git/status", { paths: ["/home/u/proj/a.ts"] })).toBeNull();
  });

  test("a remote root in the query is stripped and sent to its machine", () => {
    const t = remoteTarget(`/git/log?root=${encodeURIComponent("@rooter:/home/u/proj")}&n=50`);
    expect(t).toEqual({ host: "rooter", path: "/git/log?root=%2Fhome%2Fu%2Fproj&n=50", roots: ["/home/u/proj"] });
  });

  test("paths in a body are stripped too — files are joined onto the root", () => {
    const t = remoteTarget("/git/status", { paths: ["@rooter:/home/u/proj/a.ts", "@rooter:/home/u/proj/b.ts"], keep: 1 });
    expect(t).toEqual({ host: "rooter", path: "/git/status", roots: [], body: { paths: ["/home/u/proj/a.ts", "/home/u/proj/b.ts"], keep: 1 } });
  });

  test("a request naming two machines has nowhere to go", () => {
    expect(remoteTarget("/git/status", { paths: ["@rooter:/a", "@bean:/b"] })).toEqual({ error: "one request cannot name repositories on two machines" });
  });
});

describe("the other machine's answer", () => {
  test("paths at and under the root come back in this client's naming; text that mentions it does not", () => {
    const answer = {
      root: "/home/u/proj",
      files: [{ path: "/home/u/proj/a.ts" }, { path: "src/b.ts" }],
      sibling: "/home/u/proj-other/c.ts",
      line: "+ see /home/u/proj/a.ts",
    };
    expect(relabel(answer, "rooter", ["/home/u/proj"])).toEqual({
      root: "@rooter:/home/u/proj",
      files: [{ path: "@rooter:/home/u/proj/a.ts" }, { path: "src/b.ts" }],
      sibling: "/home/u/proj-other/c.ts",
      line: "+ see /home/u/proj/a.ts",
    });
  });
});

describe("what a person wrote", () => {
  test("is never taken for a path, even when it looks like one", () => {
    const t = remoteTarget("/chat/send", { cwd: "@rooter:/home/u/proj", message: "@bean:/etc/passwd is what I mean" });
    expect(t).toEqual({ host: "rooter", path: "/chat/send", roots: [], body: { cwd: "/home/u/proj", message: "@bean:/etc/passwd is what I mean" } });
  });
});

