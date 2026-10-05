# Fleet — one cockpit across machines

agentglass was built to watch every agent on **one** machine. This is the plan
for watching several — a desk, a laptop, a headless box driven over Remote
Control, and, as far as it can go, sessions running in Anthropic's cloud — from
a single cockpit.

Status: **phase 1 built** (host identity, no link yet). Everything from phase 2 on is design, not code.

---

## The shape

```
bean   (agentglass, node) ──┐
rooter (agentglass, node) ──┼── outbound link ──►  server (agentglass, hub)  ◄── browsers, phone
cloud session (hook only) ──┘   (NAT-friendly)
```

Every machine keeps running a full agentglass, exactly as today. That instance
is already the right collector for its own machine: it scans `~/.claude/projects`,
dedupes hooks against the scanner, prices every turn, resolves worktrees with its
own `git`, and holds gated tool calls in-process. None of that can be done well
from somewhere else, so none of it moves.

What is added is a **link**: a node forwards the rows it has *already* ingested
to one **hub**, which stores them tagged with the host they came from and shows
everything in one place. Actions on a remote session — answering a gate, reading
a diff — travel back down the same link and run on the machine that owns the
session.

**The hub is the always-on box.** It is the one address the phone pairs with
and the browsers open, and it is the one machine guaranteed to be awake. Nodes
connect *out* to it, so a sleeping desktop or one behind NAT costs nothing: it
catches up when it wakes.

### Why not the obvious shortcuts

| Shortcut | What breaks |
|---|---|
| Point every machine's hooks at the hub (`AGENTGLASS_ALLOW_REMOTE=1`) | No history — the transcript scanner only reads local disk. Gates fail open whenever the hub is unreachable. Remote paths get resolved with the hub's own `git`, against the hub's own repos. |
| Hub pulls from each node | The hub has to reach machines that sleep and sit behind NAT. Push-from-node inverts that for free. |
| sshfs the box's `~/.claude/projects` into `AGENTGLASS_PROJECTS_DIR` | Works with zero code and is a fine preview. But identical paths on two machines (`/home/you/...`) merge into one project, worktree resolution runs against the wrong repos, and nothing records which host a session lived on. |

---

## Phases

### 1. Host identity

Every row knows the machine it came from. Useful on its own and harmless on a
single machine — nothing about a one-machine install changes.

- **A host id per instance.** `AGENTGLASS_HOST_ID`, or `hostId` in
  `config.json`, defaulting to the machine's hostname. Reported on `/health`.
- **`host` on `events`, `sessions` and `gates`. NULL means "this machine".**
  Local rows are never stamped, so there is no backfill over a multi-GB events
  table, nothing changes for a single-machine install, and renaming the host id
  does not orphan its own history. Only rows that arrived from somewhere else
  carry a value. Wherever a host is *shown*, NULL reads as this instance's id.
- **Foreign paths are not ours to resolve.** A row with a host is never run
  through local `git`, `inScope` or `accountForPath`: its `project_path`, account
  and cost were settled on the machine that produced it. `/home/you/x` on the box
  and `/home/you/x` here are different projects.
- **Workspace scope is per-host.** A cockpit scoped to a project is scoped to
  that project *on this machine*; a foreign session never matches a local scope
  by sharing a path string.
- **A host filter**, built the way the provider and account filters are:
  `?host=` on `/events/recent`, `/sessions` and `/stats`, a host picker beside
  the provider picker, and a host chip on session cards. All of it stays hidden
  until a second host has actually been seen.

What phase 1 deliberately leaves for the link to settle:

- **Nothing writes a foreign row yet.** `NormalizedEvent.host` exists and is
  stored, but `normalize()` never reads it from an ingest body — a hook, or a
  repo-local `settings.json` aiming one, cannot claim to be another machine.
  The link is the only writer it is meant to have.
- **Host is per event, latched per session.** A session's host is set by its
  first row that names one and never moves. The link must stamp *every* row it
  forwards, or the unstamped ones read as local.
- **Fallback session ids collide across machines.** The hooks fall back to
  `"unknown"` and OTLP to `"otel-session"`; the receiving end must namespace
  those by host before they meet `sessions.session_id`, which is still the key.
- **The daily rollup has no host.** Once retention folds events into
  `daily_rollup`, the long-range daily series is whole-fleet only — the same as
  it already is for provider and account.
- **Liveness evidence for a remote open tool call is "none".** Its transcript
  and files are on the other machine; the node will have to forward its own
  verdict.
- **The card chip appears only when the cards on screen span more than one
  host.** A wall of cards from one remote machine shows no chip; the host
  picker still says which machine it is.

Set the name with `AGENTGLASS_HOST_ID=box` or `"hostId": "box"` in
`~/.config/agentglass/config.json`; `/health` reports it.

### 2. The link

- A node with `upstream: { url, credential }` holds a WebSocket open to the hub.
- It streams rows as they are inserted — post-dedup, post-pricing — with its own
  `events.id` as the cursor. The hub inserts idempotently on `(host, origin id)`
  and acknowledges; the node persists the acknowledged cursor, so after sleep or
  a dropped network it backfills the gap on reconnect.
- Session metadata (titles, Cowork session meta) rides the same link.
- The hub shows each node online/offline and when it was last heard from.
- The node's credential comes from the existing pairing flow — six digits shown
  at the hub, accepted by a person there — as a new `node` grant.

### 3. Gates from anywhere

- The gate stays where the session runs. The hook still talks to `127.0.0.1`;
  if the hub is down, nothing about gating changes.
- The node forwards "a call is held" up the link; a decision made at the hub is
  sent down and resolved locally. The decision is attributed (`decided_by`) to
  the hub device that made it.

### 4. Remote workspace, one tier at a time

- A request tunnel: the hub sends `{method, path, query, body}` down the link,
  the node runs it against its own router under its own scope checks.
- **The node sets the ceiling, never the hub.** Default ceiling: read + answer.
- Order: diff and file view → git tree → chat / resume (runs `claude --resume`
  on the owning node) → terminal last, if ever. A PTY across the link is both
  the hardest to stream and the most dangerous thing to grant.

### 5. Cloud sessions (live events only)

Repo hooks run in single-repo Claude Code cloud sessions, and `type: "http"`
hooks can post out if the environment's network policy allows the destination.

- The hub grows a **separate ingest-only listener**: `/ingest` and nothing else,
  token required, exposed with Tailscale Funnel. The real server — the one that
  opens shells — is never on the internet.
- The repo hook fires only when `CLAUDE_CODE_REMOTE` is set *and* the token env
  is present, so a clone of the repo posts nowhere.
- Cloud rows are stamped host `cloud`, session id from
  `CLAUDE_CODE_REMOTE_SESSION_ID`.
- What you do not get: transcript history (there is no API for cloud
  transcripts), gates, or workspace panels. Cost only if a command hook embeds
  the transcript at `Stop`.

---

## Things to keep in view

- **Transcripts move.** A node forwards prompts, file contents and command
  output to the hub. The hub's database deserves the same care as `~/.claude`.
- **Grants.** Phase 4 is where the hub gains reach into other machines; that is
  why the ceiling is node-side and the terminal is last.
- **Upstream merges.** This fork tracks SirAllap/agentglass. The link and hub
  live in their own modules; changes to `db.ts` and `index.ts` stay thin seams.
  Phases 1–3 are generic enough to offer upstream.
