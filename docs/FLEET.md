# Fleet — one cockpit across machines

agentglass was built to watch every agent on **one** machine. This is the plan
for watching several — a desk, a laptop, a headless box driven over Remote
Control, and, as far as it can go, sessions running in Anthropic's cloud — from
a single cockpit.

Status: **phases 1–4 built** — every row knows its host, nodes forward to a
hub, a node's held tool calls can be answered there, the hub's Git panel reads
a node's repositories, and a node's session can be resumed from the hub and run
there. Phase 5 is design, not code.

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

No restart is needed to start forwarding. **Answering a node's holds from the
hub needs one restart of the node after joining** — see phase 3 for why. The
hub URL has to keep the link private: `https`, a
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

Built: `gate`/`decide`/`decided` frames in `fleetwire.ts`, the hub's queue of
remote holds in `fleethub.ts`, the relay in `fleetlink.ts`.

- **The hold stays where the session runs.** The hook still talks to
  `127.0.0.1`, the node keeps the hold, its timer and its fail-open/closed
  policy. A hub that is down or unreachable changes nothing about gating.
- **The node sends its whole queue** on connect and on every change. The hub
  lists those holds beside its own in `/gate/pending`, each carrying `host`, and
  raises the same approval alert a local hold does — desk notification and
  paired phone — naming the machine. A node that goes offline takes its holds
  off the hub's list; a hold past its deadline is not offered.
- **An answer at the hub is checked exactly as a local one is** — Origin, and
  that the held party cannot release itself (`mayReleaseAHold`) — then sent down
  the link. The node accepts it only for a hold it actually forwarded, records it
  as `<who pressed it> via <hub>` (keeping the machine-token form when that is
  what pressed it, so the model is not told a person reviewed it), and says
  whether it took: it may have timed out, or been answered at that machine.
- **Answers are only taken from the hub the node started with.** The held party
  is an agent running as you, and it can write `upstream.json`. Trusting a
  runtime change for answers would let it point the node at a "hub" of its own
  and approve its own calls. So joining at runtime forwards rows at once, and
  answers start after the node's next restart — the line `devices.json` draws,
  with the same ceiling. `bun run fleet status` says which state a node is in.
- **Off switch on the node:** `AGENTGLASS_UPSTREAM_GATES=0`, or `"gates": false`
  in `upstream.json`. Forwarding rows continues; holds stay local.

What phase 3 leaves open:

- **Remote gate history** is on the node (`/gate/history` there), not the hub.
- **Other alerts** — a run finishing, a tool failing — still do not cross the
  link; only holds do.

### 4. Remote workspace, one tier at a time

Built: the **read** tier — `req`/`res` frames, `tunnelAllows` in auth.ts,
`requestRemote` in fleethub.ts, the node's dispatcher in fleetlink.ts,
`POST /fleet/proxy`, and `web/src/lib/remoteRoot.ts`.

- **A request tunnel.** The hub sends `{method, path, query, body}` down the
  link; the node rebuilds it from the path alone — none of the hub's headers —
  and runs it through its own router as a call from itself, so its own scope
  and repository checks decide. The answer comes back as itself.
- **The node sets the ceiling, never the hub.** `tunnelAllows` is the whole
  boundary and is checked on the node: the workspace views (`/git/*`,
  `/files/*`, `/changes`, `/fs/complete`) and only what `scopeNeeded` calls a
  read — exactly what a read-scope paired phone could ask of that machine. The
  hub checks it too, so a refusal is fast and a write is never even forwarded.
  `AGENTGLASS_UPSTREAM_TUNNEL=off`, or `"tunnel": "off"` in `upstream.json`,
  closes it.
- **The hub's Git panel lists every linked machine's repositories** beside its
  own, named `proj @rooter`. Picking one reads its changes, diffs, log, graph,
  branches, stashes and history from that machine, live. Write controls are
  disabled and say why.
- **How the panel does it without knowing:** a remote root is `@rooter:/path`
  — never a local path, which always starts with `/`. The API transport is the
  one place that notices: it strips the prefix, sends the request through
  `/fleet/proxy`, and puts the prefix back on any path in the answer that sits
  under the root it asked about. Panels keep passing `root` around as before.

#### Second tier: chat and resume

Built: the `answer` and `chat` tiers, streamed answers (`res-head`/`res-data`/
`res-end`, `cancel`), scoped tunnel credentials, and "Resume on <host>".

- **A node chooses how far the hub may go** (`TunnelTier` in auth.ts):

  | tier | the hub may |
  |---|---|
  | `off` | nothing |
  | `read` *(default)* | read the workspace views |
  | `answer` | also reply to a session that is running now |
  | `chat` | also resume an idle session or start a new chat |

  Set it with `bun run fleet join … --tunnel=chat`, `"tunnel"` in
  `upstream.json`, or `AGENTGLASS_UPSTREAM_TUNNEL`. The chat tiers open exactly
  the chat routes (`/chat/send`, `/chat/pane/key`, `/chat/active`,
  `/chat/panes`) — never the terminal, git writes, Codex or anything else.
- **A turn runs with the lower of two scopes:** the hub caller's (a phone paired
  for `answer` stays `answer`) and the node's tier (`answer` → `answer`, `chat`
  → `full`). The node runs each tunnelled request with an in-memory credential
  for exactly that scope — principal `hub`, fenced in `allowed` to the tunnel's
  routes — so chat.ts's own `scopedTurn` draws the line it already draws for a
  paired phone: `answer` replies to what is running, `full` wakes what is not.
  The hub grades the caller against the inner route too, before forwarding.
- **Only the hub this node started with.** `answer` and `chat` start agents at
  the hub's word, so they take the line gate answers take: a tier set after the
  node started stands at `read` until it restarts. `fleet status` says so.
- **Streamed.** The node sends the answer's head, then its body as it comes,
  then the end; the hub hands its caller a stream. Stopping the turn at the hub
  cancels the stream, and the node stops the turn — the whole process tree —
  exactly as a local stop does.
- **The ask-and-approve rule holds across the link.** The device that sent a
  remote session its turn cannot also allow that turn's held call at the hub;
  the hub records the sender, since it is where the hold is decided.
- **In the UI,** another machine's session offers **Resume on <host>** when
  that node is linked at the `chat` tier. The chat opens with its directory as
  `@host:/path`, so every turn routes there; its history replays from the
  forwarded session, and it follows along live from the forwarded events.

Last tier: the terminal, if ever. A PTY across the link is both the hardest to
stream and the most dangerous thing to grant.

What the read tier leaves open:

- **Only the Git panel reads remote repositories**, and only a session's own
  Resume opens a remote chat. Files, budgets and the rest list this machine's
  only, and the chat panel's own resume picker lists this machine's sessions.
- **Claude only.** Codex and Antigravity chats are not carried.
- **A remote chat's permission prompt** (the tmux engine's on-screen "allow?")
  is answered through gates, not through `/chat/pane/key` keystrokes from the
  hub's chat view, which address panes by this machine's session names.
- **Views outside the tier** — the PR badge, anything under `/prs` — answer
  "read-only over the fleet link" for a remote repository.
- **Switching to a linked worktree** of a remote repository from inside it is
  not mapped yet: worktrees live beside the root, not under it.
- **Answers are capped at 3 MB** (a 413 that says so), and a node answers at
  most 16 requests at once.

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
