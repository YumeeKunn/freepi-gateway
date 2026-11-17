#!/usr/bin/env python3
"""
Free-Pi ad keepalive.

Free-pi pauses free completions until an ad impression has been recorded for the
account. The free-pi CLI does this by calling GET /ads/next and then
POST /ads/impression. This script does exactly that, on a timer, without running
the CLI or its terminal UI.

  ./ads-keepalive.py                run in the foreground, every 5 minutes
  ./ads-keepalive.py --once         a single cycle, then exit
  ./ads-keepalive.py --interval 300 seconds between cycles
  ./ads-keepalive.py --quiet        no output except errors

Exit codes: 0 ok, 1 credentials or session problem, 2 network/upstream problem.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = os.environ.get("FREEPI_BASE_URL", "https://api.freepi.ai").rstrip("/")
CREDENTIALS = os.path.expanduser(
    os.environ.get("FREEPI_CREDENTIALS", "~/.free-pi/agent/credentials.json")
)
SESSION_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "session.json"
)
CLIENT_VERSION = os.environ.get("FREEPI_CLIENT_VERSION", "0.6.22")
SLOT = os.environ.get("FREEPI_AD_SLOT", "banner")


def log(quiet, msg):
    if not quiet:
        print(time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg, flush=True)


def read_token():
    try:
        with open(CREDENTIALS, "r", encoding="utf8") as f:
            token = json.load(f).get("token")
    except Exception as exc:
        raise SystemExit(f"cannot read free-pi credentials at {CREDENTIALS}: {exc}")
    if not isinstance(token, str) or not token:
        raise SystemExit(f"no token in {CREDENTIALS}; sign in with the free-pi CLI once")
    return token


def read_session_id():
    """The session id the gateway uses for completions, so ads line up with them."""
    try:
        with open(SESSION_FILE, "r", encoding="utf8") as f:
            sid = json.load(f).get("sessionId")
        if isinstance(sid, str) and sid:
            return sid
    except Exception:
        pass
    return None


def request(path, token, session_id, method="GET", body=None):
    headers = {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
    }
    if session_id and (path.startswith("/ads/next") or path == "/ads/impression"):
        headers["x-session-id"] = session_id
    if path.startswith("/ads/next"):
        headers.update(
            {
                "x-client-version": CLIENT_VERSION,
                "x-client-os": "linux",
                "x-client-arch": "x64",
            }
        )
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode("utf8", "replace")
            return res.status, raw
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf8", "replace")
    except Exception as exc:
        return 0, str(exc)


def cycle(token, session_id, quiet):
    status, raw = request(f"/ads/next?slot={SLOT}", token, session_id)

    if status == 204:
        log(quiet, "no ad available (204), nothing to report")
        return 0
    if status != 200:
        log(quiet, f"ads/next failed: HTTP {status} {raw[:200]}")
        return 2

    try:
        ad = json.loads(raw)
        ad_id = ad["ad_id"]
        click_token = ad["click_token"]
    except Exception:
        log(quiet, f"ads/next returned an unexpected payload: {raw[:200]}")
        return 2

    status, raw = request(
        "/ads/impression",
        token,
        session_id,
        method="POST",
        body={"ad_id": ad_id, "click_token": click_token},
    )
    if status != 200:
        log(quiet, f"ads/impression failed: HTTP {status} {raw[:200]}")
        return 2

    creative = ad.get("creative") or {}
    log(quiet, f"impression ok: {creative.get('headline', 'ad')} [{ad_id[:8]}]")
    return 0


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--interval", type=int, default=300, help="seconds between cycles (default 300)")
    parser.add_argument("--once", action="store_true", help="run one cycle and exit")
    parser.add_argument("--quiet", action="store_true", help="only print errors")
    args = parser.parse_args()

    if args.interval < 60:
        raise SystemExit("--interval must be at least 60 seconds")

    token = read_token()
    session_id = read_session_id()
    log(args.quiet, f"session id: {session_id or 'none (using account defaults)'}")

    if args.once:
        return cycle(token, session_id, args.quiet)

    while True:
        try:
            cycle(token, session_id, args.quiet)
        except Exception as exc:
            log(args.quiet, f"cycle error: {exc}")
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
