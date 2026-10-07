#!/usr/bin/env python3
"""agentglass cloud hook — report a Claude Code cloud session to your hub.

Copy this file into the repository a cloud session works on, as
`.claude/hooks/agentglass_cloud.py`, and wire it from that repository's
`.claude/settings.json` (`bun run fleet add-cloud` prints the exact snippet).
Zero third-party dependencies; stdlib only.

It does nothing — no network, no output — unless ALL of these are true:

  * it is running in a Claude Code cloud session (CLAUDE_CODE_REMOTE is set),
  * AGENTGLASS_CLOUD_URL is set, and is https,
  * AGENTGLASS_CLOUD_TOKEN is set.

Those two variables live in the cloud environment's settings, never in the
repository. That is what makes it safe to commit: a clone of this repository on
somebody's laptop runs the hook, finds no CLAUDE_CODE_REMOTE and no URL, and
exits — their sessions go nowhere, and certainly not to your hub.

It never prints and always exits 0, so it cannot block, deny or alter anything
in the session it reports on. A hub that is down costs three seconds at most.
"""
import json
import os
import sys
import urllib.request

TIMEOUT_S = 3
# The events whose turn is complete enough to price: the transcript is attached
# so the hub can count tokens and cost, which a hook payload alone does not say.
WITH_TRANSCRIPT = {"Stop", "SubagentStop", "SessionEnd"}
# A long session's transcript is large; past this, cost is left to the next
# event rather than sending megabytes on every Stop.
MAX_TRANSCRIPT_BYTES = 6 * 1024 * 1024


def read_transcript(path):
    """(chat_lines, model) from a Claude Code transcript JSONL, or ([], None)."""
    chat, model = [], None
    try:
        if os.path.getsize(path) > MAX_TRANSCRIPT_BYTES:
            return chat, model
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                chat.append(obj)
                msg = obj.get("message") or {}
                if isinstance(msg, dict) and msg.get("model"):
                    model = msg["model"]
    except OSError:
        pass
    return chat, model


def main():
    if not os.environ.get("CLAUDE_CODE_REMOTE"):
        return
    url = os.environ.get("AGENTGLASS_CLOUD_URL", "").strip().rstrip("/")
    token = os.environ.get("AGENTGLASS_CLOUD_TOKEN", "").strip()
    # https only: the body is the session's prompts, commands and file contents,
    # and the token rides in the header.
    if not url.startswith("https://") or not token:
        return
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, OSError):
        return
    if not isinstance(payload, dict):
        return
    session_id = payload.get("session_id") or payload.get("sessionId")
    event_type = payload.get("hook_event_name")
    if not session_id or not event_type:
        return
    cwd = payload.get("cwd") or os.getcwd()
    body = {
        "source_app": os.path.basename(os.path.normpath(cwd)) or "cloud",
        "session_id": session_id,
        "hook_event_type": event_type,
        "payload": payload,
        "model_name": payload.get("model") or payload.get("model_name"),
    }
    # The claude.ai/code session this is, so the hub can link to it.
    remote_id = os.environ.get("CLAUDE_CODE_REMOTE_SESSION_ID")
    if remote_id:
        payload["cloud_session_id"] = remote_id
    if event_type in WITH_TRANSCRIPT:
        tpath = payload.get("transcript_path")
        if tpath:
            chat, model = read_transcript(tpath)
            if chat:
                body["chat"] = chat
                body["model_name"] = body["model_name"] or model
    req = urllib.request.Request(
        url + "/cloud/ingest",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=TIMEOUT_S).read()
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
