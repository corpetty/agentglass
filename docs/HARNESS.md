# The multi-subscription harness

This fork turns agentglass from a **monitor** into a **scheduler**: one cockpit
that watches *and drives* headless `claude -p` work across more than one Claude
subscription, keeping each fully used **without any possibility of overage
billing**.

Everything here is additive — a single-account, single-login setup keeps working
with zero configuration. The features only appear once you actually have a second
account or queue a job.

- [Accounts — attribution by login](#accounts--attribution-by-login)
- [Usage meters & token refresh](#usage-meters--token-refresh)
- [The job queue & dispatcher](#the-job-queue--dispatcher)
- [Reviewing a finished job](#reviewing-a-finished-job)
- [Desktop instances](#desktop-instances)
- [Safety & ToS posture](#safety--tos-posture)
- [Reference](#reference)

---

## Accounts — attribution by login

Every event and session carries an **account** tag — which Claude subscription
produced it. It's resolved in this order:

1. **`AGENTGLASS_ACCOUNT`** on the hook's environment — authoritative for a live
   session (the dispatcher sets it on every job it runs).
2. **Which login dir the transcript came from** — a session under an account's
   own `CLAUDE_CONFIG_DIR` (see below) is tagged with that account. This is the
   decisive signal, because *which login ran it* is what "which account" means.
3. **`accountPaths`** — an optional working-directory-prefix fallback, only for
   sessions on the shared default `~/.claude` login (below).
4. Default **`work`**.

> **Attribute by login, not by folder.** The `accountPaths` fallback is a
> heuristic for the *shared* default login and is easy to get wrong — a work
> login sitting in a personal-org repo is still the work login. If your accounts
> have their own `claude_config_dir` (the recommended setup), leave `accountPaths`
> empty and let the config-dir signal decide.

### The registry

Accounts live under `accounts` in `~/.config/agentglass/config.json` (or
`$XDG_CONFIG_HOME/agentglass/config.json`). Each entry:

| Field | Meaning |
|---|---|
| `id` | Stable identifier **and** the event tag, e.g. `"work"`, `"personal"`. |
| `label` | Display name (falls back to `id`). |
| `plan_tier` | Free-form scheduling hint, e.g. `"pro"`, `"max5x"`, `"max20x"`. |
| `claude_config_dir` | The account's CLI login dir (its `CLAUDE_CONFIG_DIR`). Holds `.credentials.json` (for the meter) and `projects/` (for the scanner). **Absent → the default `~/.claude` login.** |
| `account_paths` | Optional cwd prefixes that map to this account — only used as the shared-login fallback. Prefer leaving empty. |
| `desktop_instance` | Optional link to a desktop instance name (see below). |

The default `~/.claude` login is **always represented**, even once you configure
others: if no configured account uses the default dir, a synthesized `work`
account is added. So configuring a second account never makes the first vanish.

```jsonc
// ~/.config/agentglass/config.json
{
  "accounts": [
    { "id": "personal", "label": "Personal", "plan_tier": "max5x",
      "claude_config_dir": "~/.claude-accounts/personal" }
  ]
}
```

That example yields two accounts: the synthesized `work` (on `~/.claude`) and
`personal` (on its own login dir).

### Provisioning a second account

Give the account its own login dir, once:

```bash
CLAUDE_CONFIG_DIR=~/.claude-accounts/personal claude auth login   # sign in as that account
CLAUDE_CONFIG_DIR=~/.claude-accounts/personal claude auth status  # verify
```

Then register it — either add the block to `config.json` above, or use the
**Accounts panel → + add account** (`a`) and set its *config dir*. The scanner
now reads `~/.claude-accounts/personal/projects` and tags those sessions
`personal`; the meter reads its `.credentials.json`.

> Config is read once at startup. **Restart the server after editing
> `config.json`** (the Accounts-panel CRUD invalidates the cache for you; a hand
> edit needs a restart).

### The Accounts panel — `a`

Header **👥** or press `a`. Shows every account with live **5-hour and weekly
gauges** (per-model buckets on Max), reset countdowns, a **login-status** chip
(connected / re-login needed / rate-limited / not logged in) with inline fix
commands, and add / edit / remove. The **Desktop instances** section lives here
too.

---

## Usage meters & token refresh

`GET /usage?account=<id>` (and `/usage/all`) polls Anthropic's OAuth usage
endpoint per account, reading each one's `.credentials.json`. One reading per
account, cached with independent back-off, exposing the **5-hour** and **weekly**
windows (plus per-model weekly buckets on Max) and their reset times — this is
what the scheduler sizes work against.

**Idle accounts self-heal.** The meter needs a non-expired OAuth *access* token,
but Claude Code only refreshes that on use — so an account you *watch* but rarely
run would otherwise go stale and 401. `oauth.ts` refreshes it the same way Claude
Code does (its token endpoint + client id), writing the rotated credential back
atomically at `0600`. Disable with `AGENTGLASS_TOKEN_REFRESH=0` (the meter then
just reports `re-login needed` when a token expires).

Nothing here leaves your machine except the calls to `api.anthropic.com` /
`platform.claude.com` that the token was minted for.

---

## The job queue & dispatcher

Queue a prompt to run unattended in a repo, under one of your accounts, and the
dispatcher runs it as a headless `claude -p` when that account has headroom.

### Cost-safety — the guarantees

An unattended run must never cost money beyond the subscriptions. That's enforced
in code, not left to configuration:

- **No metered billing, ever.** The executor **strips `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` from the job's environment**, so a job can *only*
  authenticate with the account's subscription login. Exhausting a limit blocks
  the request — it never converts to pay-per-token.
- **No runaway.** `--max-turns` is mandatory on every job (a looping job can't
  burn a whole window).
- **Smoothed load.** One headless job per account at a time, and an account is
  skipped once its utilization reaches the **queue ceiling** (an *interactive
  reserve*, default 80%) — queue work never crowds out the human at the keyboard.
- Own process group (a timeout kill reaches the whole tool tree), and
  `CLAUDECODE` is cleared so a job runs even if the server itself sits inside a
  Claude Code session.

### The scheduling policy

Every tick (~30s) the dispatcher:

1. Frees any **blocked** job whose dependencies are all `done` (and fails one
   whose dependency can never complete); expires jobs whose time window closed.
2. For each `queued` job in **priority then age** order, within its window, picks
   the **eligible account with the most headroom** — the lowest of its 5-hour and
   weekly utilization — skipping accounts at/above the ceiling, over their
   concurrency cap, not logged in, or paused after a rate limit.
3. Runs it. On a rate-limit it **pauses that account until its reset** and
   requeues the job without penalty; other accounts keep going. On failure it
   retries up to `max_attempts`, then marks `failed`. On success it records the
   result and links the session.

A job left `running` when the server stops is requeued on the next boot — nothing
is orphaned.

### Queuing work

**One-off, in the UI** — Queue panel (header 🗒️ or `q`) → fill in prompt, cwd (a
git repo), account (`any` = pick by headroom), priority, max turns, permission
mode.

**One job, over HTTP:**

```bash
curl -X POST localhost:4000/jobs -H 'content-type: application/json' -d '{
  "prompt": "Read server/src/queue.ts and describe its state machine.",
  "cwd": "/home/you/Github/agentglass",
  "account_id": "personal",
  "allowed_tools": ["Read"],
  "max_turns": 5,
  "model": "claude-haiku-4-5-20251001"
}'
```

**A predefined batch** (for an overnight run) — `POST /jobs/batch` with
`{ "jobs": [ … ] }` (or a bare array); each item is validated independently and
you get a per-item result.

Job fields: `prompt`, `cwd` (required); `account_id` (`"any"` or an id),
`priority` (0–100), `window_start`/`window_end` (ms epoch), `model`,
`permission_mode` (`default` | `plan` | `acceptEdits` | `bypassPermissions`),
`allowed_tools` (pre-approved specs — `claude -p` can't prompt, so anything not
listed is refused mid-run), `max_turns`, `depends_on` (job ids), `max_attempts`.

---

## Reviewing a finished job

Because the queue links every job → its session → its on-disk transcript, an
automated run is as inspectable as one you drove by hand. Four levels:

| You want… | Where |
|---|---|
| **What it concluded** | the job's `result_summary` — Queue panel, or `GET /jobs`. |
| **When/where it ran, retries** | its dispatch log — `GET /jobs/detail?id=<jobId>` (`queued → started (account) → completed`, timings, any `requeued`/`failed`). |
| **What it did, step by step** | its **session** — the Queue row's *open session ↗*, or `GET /session?id=<sessionId>`: the timeline of messages + tool calls interleaved, tool mix, cost, tokens, file changes. |
| **The complete unabridged log** | the raw transcript on disk: `<claude_config_dir>/projects/<encoded-repo>/<sessionId>.jsonl`. |

`result_session_id` on the job is the `<sessionId>` for the last two.

---

## Desktop instances

The Claude **Desktop** app (Electron) can't be read as JSONL transcripts, so it's
managed at the **process level only** — launch / stop / detect, no message
injection. Queued *work* goes through the CLI dispatcher; the desktop apps are
just made visible and controllable.

An instance is a profile keyed by its Electron `--user-data-dir`:

- **`default`** — the normal profile at `~/.config/Claude`.
- **`<name>`** — one per `~/.claude-instances/<name>`, launched with
  `XDG_CONFIG_HOME=<dir>/config` so Electron isolates its state (and its
  single-instance lock) to `<dir>/config/Claude`.

The **Desktop instances** section on the Accounts panel shows each with its
running state / pid count / linked account, and **launch** / **stop** buttons.
Launch is idempotent (a running instance is left alone); it spawns detached so it
outlives the server. Link an instance to an account by setting that account's
*desktop instance* in the account editor.

Disable the manager with `AGENTGLASS_INSTANCES_DISABLED=1`; point it at a
non-standard binary with `AGENTGLASS_DESKTOP_BIN`.

> First-time login routing for an isolated instance (the `claude://` OAuth
> callback) is a one-time manual setup — see `claude-desktop-multi-instance.md`.
> The manager launches already-provisioned profiles.

---

## Safety & ToS posture

- All automation runs on the **official Claude Code CLI** under each account's
  own login. No OAuth-token passthrough to third-party tools; the only network
  the harness adds is the read-only usage meter and the token refresh, both to
  Anthropic with the account's own credentials.
- Per-account concurrency of 1 and headroom-based, ceiling-capped scheduling keep
  usage **human-shaped** — the pattern least likely to draw scrutiny. Aggressive
  parallel bursts across accounts are exactly what to avoid; the dispatcher
  smooths load rather than spiking it.
- The server still binds `127.0.0.1` only. Every kill-switch is honored (below).

---

## Reference

### Environment variables

| Var | Default | Meaning |
|---|---|---|
| `AGENTGLASS_ACCOUNT` | — | On a **hook's** env: tag this session's events with this account id. The dispatcher sets it per job. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | An account's CLI login dir. Set per account in `config.json` (`claude_config_dir`); used at login time and by the dispatcher when running that account's jobs. |
| `CLAUDE_CREDENTIALS` | `<config_dir>/.credentials.json` | Overrides where the **default** account's OAuth token is read from. |
| `AGENTGLASS_TOKEN_REFRESH` | `1` | `0` → don't refresh expired OAuth access tokens (the meter reports `re-login needed` instead). |
| `AGENTGLASS_DISPATCH_DISABLED` | — | `1` → don't run the job dispatcher (the queue still accepts jobs; nothing executes). |
| `AGENTGLASS_DISPATCH_INTERVAL_MS` | `30000` | Dispatcher tick (min 5000). |
| `AGENTGLASS_JOB_CONCURRENCY` | `1` | Headless jobs per account at once. Raise deliberately. |
| `AGENTGLASS_QUEUE_CEILING` | `80` | Utilization % (max of 5h/weekly) at/above which the queue won't start work on an account — the interactive reserve. |
| `AGENTGLASS_JOB_TIMEOUT_MS` | `1800000` | Hard wall-clock ceiling per job (30 min). |
| `AGENTGLASS_JOB_STARTUP_TIMEOUT_MS` | `30000` | Kill a job that produces nothing this long (usually a login it can't complete headless). |
| `AGENTGLASS_INSTANCES_DISABLED` | — | `1` → disable the desktop instance manager. |
| `AGENTGLASS_DESKTOP_BIN` | auto | Path to the Claude Desktop binary (auto-detects `claude-desktop-unofficial` / `claude-desktop`). |

### API

| Route | Description |
|---|---|
| `GET /accounts` · `POST /accounts` · `POST /accounts/delete` | The account registry — list, create/update (a `RawAccount` body), remove (`{id}`). |
| `GET /usage?account=<id>` · `GET /usage/all` | Per-account plan-limit windows; `/usage` with no account is the default account. |
| `GET /jobs` · `POST /jobs` · `POST /jobs/batch` | List jobs; queue one (a `JobInput`); queue many (`{jobs:[…]}` or a bare array). |
| `GET /jobs/detail?id=<id>` | One job plus its attempt/dispatch history. |
| `POST /jobs/update` · `POST /jobs/cancel` | Edit `{id, priority?, window_start?, window_end?, account_id?}`; cancel `{id}` (a queued/blocked job). |
| `GET /instances` · `POST /instances/launch` · `POST /instances/stop` | Desktop profiles — list with running state, launch / stop (`{name}`). |

Writes require a same-origin caller (the CSRF gate) like every other mutating
route; `POST` is used for updates/deletes because the CORS allow-list is
`GET,POST` only.

### Files

| Module | Role |
|---|---|
| `server/src/accounts.ts` | The account registry (resolve config dir / credentials / projects dir, CRUD). |
| `server/src/oauth.ts` | Refresh an account's expired OAuth access token, write it back atomically. |
| `server/src/usage.ts` | Per-account 5h/weekly meters, with back-off and refresh. |
| `server/src/queue.ts` | Jobs + attempt-history tables, validation, dependency blocking, state machine. |
| `server/src/dispatcher.ts` | The cost-safe headless executor and the account-picking policy loop. |
| `server/src/instances.ts` | Desktop instance detect / launch / stop. |
| `web/src/components/AccountsModal.tsx` | The Accounts panel (`a`) + Desktop instances section. |
| `web/src/components/QueueModal.tsx` | The Queue panel (`q`). |
