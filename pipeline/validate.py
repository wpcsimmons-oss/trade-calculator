"""
Data safety checks. If any check fails the pipeline stops WITHOUT writing
players.json, so the last good version stays live on the site.
"""
from __future__ import annotations

import datetime as dt
import math
from collections import Counter

from . import config as C
from .engine import last_completed_week


def check_raw(data: dict) -> list[str]:
    """Checks on the downloaded data, before any math."""
    errors = []
    weekly = data["weekly"]
    if len(weekly) < 500:
        errors.append(f"Only {len(weekly)} weekly stat rows downloaded (expected thousands).")
    bad = [r for r in weekly if not (0 <= (r["target_share"] or 0) <= 1)]
    if bad:
        r = bad[0]
        errors.append(f"{len(bad)} rows have a target share outside 0-1 "
                      f"(e.g. {r['player_display_name']} week {r['week']}: {r['target_share']}).")
    return errors


def check_freshness(data: dict) -> list[str]:
    today = dt.date.fromisoformat(data["today"])
    expected = last_completed_week(data["games"], today)
    latest = max((r["week"] for r in data["weekly"]), default=0)
    if latest < expected - C.MAX_WEEKS_STALE:
        return [f"Stats are stale: latest week in the data is {latest}, "
                f"but week {expected} finished more than {C.STALE_GRACE_DAYS} day(s) ago."]
    return []


def check_output(players: list[dict], meta: dict) -> list[str]:
    errors = []
    valued = [p for p in players if p["ppg"][0] > 0]
    if len(valued) < C.MIN_PLAYERS:
        errors.append(f"Only {len(valued)} players have a value (minimum {C.MIN_PLAYERS}).")

    counts = Counter(p["p"] for p in valued)
    for pos, minimum in C.MIN_PLAYERS_PER_POSITION.items():
        if pos == "DST" and counts[pos] == 0 and any("D/ST" in n for n in meta["notes"]):
            continue                      # D/ST source was unavailable and is noted on the page
        if counts[pos] < minimum:
            errors.append(f"Only {counts[pos]} {pos}s have a value (minimum {minimum}).")

    ids = Counter(p["id"] for p in players)
    dupes = [i for i, n in ids.items() if n > 1]
    if dupes:
        errors.append(f"Duplicate player ids: {dupes[:5]}")

    n_weeks = len(meta["weeks"])
    for p in players:
        label = f"{p.get('n')} ({p['id']})"
        if not p.get("n") or p.get("p") not in C.MIN_PLAYERS_PER_POSITION:
            errors.append(f"Player missing name/position: {label}")
        for share in ("ts", "ays", "cs", "snap"):
            v = p["u"].get(share)
            if v is not None and not (0 <= v <= 1):
                errors.append(f"{label}: share '{share}' = {v} is outside 0-1.")
        for v in p["ppg"] + p["ns"]:
            if not isinstance(v, (int, float)) or math.isnan(v) or math.isinf(v) or v < 0:
                errors.append(f"{label}: bad projection value {v}.")
                break
        if max(p["ppg"]) > C.MAX_PPG:
            errors.append(f"{label}: projects {max(p['ppg'])} points per game (max sane value {C.MAX_PPG}).")
        if len(p["wk"]) != n_weeks or any(not (0 <= m <= 1.3) for m in p["wk"]):
            errors.append(f"{label}: bad weekly schedule multipliers.")
        if len(errors) > 25:
            errors.append("...more errors not shown.")
            break

    if valued and max(p["ppg"][0] for p in valued) < 12:
        errors.append("The best player projects under 12 PPR points per game - values look far too low.")
    teams = {p["t"] for p in valued if p["t"] != "FA"}
    if len(teams) < 28:
        errors.append(f"Only {len(teams)} NFL teams have valued players.")
    if not (1 <= meta["week"] <= 18):
        errors.append(f"Latest week {meta['week']} is not a real NFL week.")
    return errors
