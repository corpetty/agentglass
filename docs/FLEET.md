# Fleet — one cockpit across machines

agentglass was built to watch every agent on **one** machine. This is the plan
for watching several — a desk, a laptop, a headless box driven over Remote
Control, and, as far as it can go, sessions running in Anthropic's cloud — from
a single cockpit.

Status: **phases 1–2 built** — every row knows its host, and nodes forward to a
hub. Phases 3–5 are design, not code.

## Setting it up

On the hub — the always-on box. It needs a token, because a node credential is
only ever checked on a server that has one (`AGENTGLASS_TOKEN` in its systemd
unit, or the generated `~/.config/agentglass/token`):

```bash
bun run fleet add-node bean      # once per node; prints a credential, once
```

On each node, with its agentglass running and named to match (`AGENTGLASS_HOST_ID=bean`,
or `"hostId"` in its `config.json`, unless that is already its short hostname):

```bash
bun run fleet join http://100.x.y.z:4000 <credential>   # the hub's Tailscale address
bun run fleet status
```

No restart on either side. The hub URL has to keep the link private: `https`, a
Tailscale address (`100.64.0.0/10` or `*.ts.net`), or an ssh tunnel to
`localhost`. Plain HTTP across a LAN is refused, because the link carries
prompts and file contents and the credential rides in its first request.
`bun run fleet nodes` on the hub lists who forwards there; **Forget** in the
Remote pane revokes a node like any paired device.

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
  `config.json`, defaulting to the machine's hostname. Reported on
  `/fleet/status` — not on `/health`, which answers without a credential and
  must not hand out a hostname.
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
  `"unknown"` and OTLP to `"otel-session"`. *Settled in phase 2:* the hub stores
  an id another host already holds as `host:id`.
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
`~/.config/agentglass/config.json`; `/fleet/status` reports it.

### 2. The link

Built: `fleetwire.ts` (the wire format, and every check the hub applies),
`fleethub.ts` (the hub's socket), `fleetlink.ts` (the node's uplink),
`fleetstore.ts` (both sides' tables and queries), `scripts/fleet.ts` (the CLI).

- **One outbound WebSocket per node**, `GET /fleet/link`. The node says hello,
  the hub answers with its cursor — the highest row id it has stored from that
  host — and the node sends what comes after it in batches of at most 500 rows
  or 4 MB, one in flight, each acknowledged before the next. The cursor lives
  only on the hub, in the same transaction as the rows it covers, so the two
  sides cannot disagree about what was delivered. A node asleep for a night
  asks on waking and backfills the gap.
- **Rows are stored as sent.** The hub does not run forwarded rows through
  `insertEvent`: deltas, cost, latency pairing and the session rollup were all
  computed on the machine that saw the session, and doing them twice is a second
  answer that can disagree with the first. Sessions are mirrored column for
  column, so the hub's totals are the node's by construction. `(host, origin_id)`
  is unique, so a batch retried after a lost ack lands once.
- **Session-only changes** — a rename, an AI title arriving after its turn —
  ride a resync of the last day's sessions every minute.
- **A node credential is a device with `role: "node"`, bound to one host
  name.** It opens `/fleet/link` and nothing else (`nodeAllows` in auth.ts): it
  cannot read the hub's cockpit, answer a gate, or forward as any name but its
  own. It is minted by `POST /fleet/nodes` at the hub's own machine — the CLI
  over ssh, for a headless hub — rather than through the phone's six-digit
  pairing, whose accept step is loopback-only and built around a screen.
- **Ids that collide** are stored as `host:id` (see phase 1). A session this
  machine, or a third one, recorded is never written over.
- **The hub's live feed** gets forwarded rows from the last ten minutes, pushed
  like the scanner's. A week of backfill lands in history, not in the feed.
- **`/fleet/status`** on any instance: its own name, its uplink (state, cursor,
  last ack, why it is not live), and the nodes forwarding to it.

- **Another machine's session is never acted on here.** Resume (`/chat/send`,
  `/codex/send`, `/antigravity/send`) answers 409 naming the machine it ran on,
  and the UI shows "Ran on …" instead of the button. Handing one off to a local
  agent needs a checkout named explicitly — the session's own path is a
  directory on the other machine. Shared-tree and collision detection, run
  bills, the agent probe, tmux restore's prompt check and the retention fold all
  read this machine's rows only, and a remote card shows no branch or
  shared-tree chip read off a local checkout at the same path.

What phase 2 leaves open:

- **No alerts from forwarded rows.** A held gate or a finished run on a node
  does not notify the hub's desk yet — deliberately, until phase 3 makes it a
  decision rather than a side effect.
- **Forwarding is one hop.** A node never relays rows it was itself sent.
- **Two machines that both catalogue the same session** (Claude Desktop's
  session index can list sessions run elsewhere) show it twice on the hub, the
  second as `host:id`.
- **No hub-side UI for nodes yet** beyond the host picker and chips; status is
  `bun run fleet status` or `/fleet/status`.
- **Forwarded rows are not folded into the hub's daily rollup** (it has no host
  column). Within retention the hub has everything; past it, long-range history
  for a node lives in that node's own rollup.

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
  output to the hub. The hub's database deserves the same care as `~/.claude`,
  and its retention (`AGENTGLASS_RETENTION_DAYS`) applies to forwarded rows too.
- **Grants.** Phase 4 is where the hub gains reach into other machines; that is
  why the ceiling is node-side and the terminal is last.
- **Upstream merges.** This fork tracks SirAllap/agentglass. The link and hub
  live in their own modules; changes to `db.ts` and `index.ts` stay thin seams.
  Phases 1–3 are generic enough to offer upstream.
