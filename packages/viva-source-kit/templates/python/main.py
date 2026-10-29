"""A Viva message source (source@1), standard library only.

Viva runs this once per action: one JSON line on stdin ({"contract", "action", "config", "cursor"}), and it
reads the last JSON line of stdout. Errors go to stderr with a non-zero exit; Viva shows them in settings.
Replace the TODO parts with calls to your system.
"""
import json
import sys
from datetime import datetime, timezone


def fetch_after(config, since):
    """TODO: fetch what came after `since` from your system. Here: a few demo messages, numbered."""
    last = 5
    return [
        {"number": n, "sender": "[Example sender]", "subject": f"Example message {n}", "body": f"Message number {n} ",
         "time": datetime(2026, 10, 25, n, tzinfo=timezone.utc).isoformat()}
        for n in range(since + 1, min(since + 2, last) + 1)
    ]


def check(config):
    if not config.get("account"):
        return {"ok": False, "problem": "Enter an account"}
    return {"ok": True}


def poll(config, cursor):
    since = int(cursor or 0)
    items = fetch_after(config, since)
    return {
        "cursor": str(items[-1]["number"] if items else since),
        "messages": [
            {"id": str(item["number"]), "at": item["time"], "from": item["sender"], "title": item["subject"], "text": item["body"]}
            for item in items
        ],
    }


def main():
    # Windows consoles may not default to UTF-8; Viva reads UTF-8.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    config = request.get("config") or {}
    if request.get("action") == "check":
        answer = check(config)
    elif request.get("action") == "poll":
        answer = poll(config, request.get("cursor"))
    else:
        raise ValueError(f"Unknown action: {request.get('action')}")
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # what the user sees in settings
        print(str(err), file=sys.stderr)
        sys.exit(1)
