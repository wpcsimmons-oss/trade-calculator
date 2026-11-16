"""
The value engine. Pure Python: takes the plain data from sources.load_all()
and returns the list of players that goes into players.json.

Every weight comes from config.py. See the "How values are calculated"
section on the site (or the README) for the plain-English version.
"""
from __future__ import annotations

import datetime as dt
from collections import defaultdict

from . import config as C

SKILL = ("QB", "RB", "WR", "TE")
FORMATS = ("ppr", "half", "std")
HURT = ("IR", "PUP", "Sus", "Out", "Doubtful")
TEAM_DISPLAY = {"LA": "LAR"}          # nflverse calls the Rams "LA"
TEAM_FROM_SLEEPER = {"LAR": "LA"}
# how many players at a position count as "starters" on a depth chart
DEPTH_STARTERS = {"QB": 1, "RB": 1, "WR": 2, "TE": 1, "K": 1}


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def recency_weights(n: int) -> list[float]:
    """Weights for n games ordered most-recent first."""
    return [
        1.0 if i < C.RECENCY_FULL_GAMES else C.RECENCY_DECAY ** (i - C.RECENCY_FULL_GAMES + 1)
        for i in range(n)
    ]


def wavg(values: list[float], weights: list[float]) -> float:
    tot = sum(weights)
    return sum(v * w for v, w in zip(values, weights)) / tot if tot else 0.0


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def regress(numer: float, denom: float, league_rate: float, k: float) -> float:
    """(player total + k league-average attempts) / (player attempts + k)."""
    return (numer + k * league_rate) / (denom + k) if (denom + k) else league_rate


def age_multiplier(pos: str, age: float) -> float:
    """Linear interpolation on the age curve in config."""
    curve = sorted(C.AGE_CURVES[pos].items())
    if age <= curve[0][0]:
        return curve[0][1]
    for (a0, m0), (a1, m1) in zip(curve, curve[1:]):
        if age <= a1:
            return m0 + (m1 - m0) * (age - a0) / (a1 - a0)
    return curve[-1][1]


def role_security(pos: str, depth_rank: int | None, age: float | None) -> float:
    if pos == "DST":
        return 1.0
    if depth_rank is None:
        sec = C.ROLE_SECURITY_DEFAULT
    else:
        eff = max(1, depth_rank - DEPTH_STARTERS.get(pos, 1) + 1)
        sec = C.ROLE_SECURITY_BY_DEPTH.get(eff, C.ROLE_SECURITY_DEFAULT)
    if sec < 1 and age is not None and age <= C.YOUNG_AGE:
        sec = min(1.0, sec + C.YOUNG_ROLE_BONUS)
    return sec


def fantasy_points(line: dict, ppr: float) -> float:
    s = C.SCORING
    return (
        line.get("pass_yd", 0) * s["pass_yd"] + line.get("pass_td", 0) * s["pass_td"]
        + line.get("int", 0) * s["int"]
        + line.get("rush_yd", 0) * s["rush_yd"] + line.get("rush_td", 0) * s["rush_td"]
        + line.get("rec_yd", 0) * s["rec_yd"] + line.get("rec_td", 0) * s["rec_td"]
        + line.get("rec", 0) * ppr
    )


def dst_points_allowed_score(pa: float) -> float:
    for upper, pts in C.DST_POINTS_ALLOWED:
        if pa <= upper:
            return pts
    return C.DST_POINTS_ALLOWED[-1][1]


def years_between(birth: str | None, today: dt.date) -> float | None:
    try:
        b = dt.date.fromisoformat(str(birth)[:10])
    except (TypeError, ValueError):
        return None
    return round((today - b).days / 365.25, 1)


def last_completed_week(games: list[dict], today: dt.date) -> int:
    """Latest week whose every game finished at least STALE_GRACE_DAYS ago."""
    by_week = defaultdict(list)
    for g in games:
        by_week[g["week"]].append(dt.date.fromisoformat(g["date"]))
    done = [
        w for w, ds in by_week.items()
        if all(d + dt.timedelta(days=C.STALE_GRACE_DAYS) <= today for d in ds)
    ]
    return max(done) if done else 0


# --------------------------------------------------------------------------
# who is everybody? (names, teams, positions, ages, injury status)
# --------------------------------------------------------------------------
SLEEPER_STATUS = {"IR": "IR", "PUP": "PUP", "Sus": "Sus", "Out": "Out",
                  "Doubtful": "Doubtful", "Questionable": "Questionable"}
ROSTER_STATUS = {"RES": "IR", "DEV": "Inactive"}
OFF_TEAM = ("CUT", "RET", "EXE", "TRC", "TRT")


def build_identity(sleeper: dict | None, rosters: list[dict], today: dt.date) -> dict:
    """id -> {name, team, pos, age, status}. Sleeper wins; nflverse fills gaps."""
    ident: dict = {}
    sid_to_gsis = {}
    for r in rosters:
        if r.get("sleeper_id") and r.get("gsis_id"):
            sid_to_gsis[str(r["sleeper_id"])] = r["gsis_id"]
    roster_by_gsis = {r["gsis_id"]: r for r in rosters if r.get("gsis_id")}

    if sleeper:
        for sid, p in sleeper.items():
            if not isinstance(p, dict):
                continue
            pos = p.get("position")
            if pos not in C.FANTASY_POSITIONS:
                continue
            gsis = sid_to_gsis.get(str(sid)) or (p.get("gsis_id") or "").strip() or None
            team = p.get("team")
            if not gsis and not (team and p.get("active")):
                continue                      # unmatched and not on a team: skip
            name = p.get("full_name") or f"{p.get('first_name', '')} {p.get('last_name', '')}".strip()
            if not name:
                continue
            age = years_between(p.get("birth_date"), today)
            if age is None and isinstance(p.get("age"), (int, float)):
                age = float(p["age"])
            status = SLEEPER_STATUS.get(p.get("injury_status") or "")
            ros = roster_by_gsis.get(gsis) if gsis else None
            if status is None and ros and ros.get("status") == "RES" and team:
                status = "IR"
            ident[gsis or f"S{sid}"] = {
                "name": name, "team": TEAM_FROM_SLEEPER.get(team, team), "pos": pos,
                "age": age if age is not None else (years_between(ros.get("birth_date"), today) if ros else None),
                "status": status,
            }

    for r in rosters:
        g = r.get("gsis_id")
        if not g or g in ident or r.get("position") not in C.FANTASY_POSITIONS:
            continue
        st = r.get("status")
        ident[g] = {
            "name": r.get("full_name"), "pos": r["position"],
            "team": None if st in OFF_TEAM else r.get("team"),
            "age": years_between(r.get("birth_date"), today),
            "status": ROSTER_STATUS.get(st),
        }
    return ident


def apply_injury_reports(ident: dict, injuries: list[dict], games: list[dict]) -> None:
    """Used only when Sleeper is unavailable: nflverse weekly injury reports."""
    unplayed = {(g[s], g["week"]) for g in games if not g["played"] for s in ("home", "away")}
    latest = {}
    for i in injuries:
        latest[i["team"]] = max(latest.get(i["team"], 0), int(i["week"]))
    for i in injuries:
        p = ident.get(i["gsis_id"])
        if not p or p["status"] or int(i["week"]) != latest[i["team"]]:
            continue
        st = i["report_status"]
        if (i["team"], int(i["week"])) in unplayed:
            p["status"] = st if st in C.AVAILABILITY else None
        elif st in ("Out", "Doubtful"):
            p["status"] = "Questionable"       # report is for a game already played


# --------------------------------------------------------------------------
# league-wide context: average efficiency and TD rates
# --------------------------------------------------------------------------
def league_context(data: dict) -> dict:
    tot = defaultdict(lambda: defaultdict(float))
    for r in data["weekly"]:
        t = tot[r["position"]]
        for key in ("attempts", "passing_yards", "passing_tds", "passing_interceptions", "carries",
                    "rushing_yards", "targets", "receptions", "receiving_yards"):
            t[key] += r[key] or 0
    ctx = {"ypt": {}, "catch": {}, "ypc": {}}
    for pos in SKILL:
        t = tot[pos]
        ctx["ypt"][pos] = t["receiving_yards"] / t["targets"] if t["targets"] else 7.5
        ctx["catch"][pos] = t["receptions"] / t["targets"] if t["targets"] else 0.65
        ctx["ypc"][pos] = t["rushing_yards"] / t["carries"] if t["carries"] else 4.2
    q = tot["QB"]
    ctx["ypa"] = q["passing_yards"] / q["attempts"] if q["attempts"] else 7.0
    ctx["pass_td_rate"] = q["passing_tds"] / q["attempts"] if q["attempts"] else 0.045
    ctx["int_rate"] = q["passing_interceptions"] / q["attempts"] if q["attempts"] else 0.023

    lt = data.get("league_td") or {}

    def rate(n, d, default):
        return lt[n] / lt[d] if lt.get(d) else default

    ctx["td"] = {
        "gl_car": rate("gl_car_td", "gl_car", 0.40), "rz_car": rate("rz_car_td", "rz_car", 0.06),
        "open_car": rate("open_car_td", "open_car", 0.005),
        "rz_tgt": rate("rz_tgt_td", "rz_tgt", 0.22), "open_tgt": rate("open_tgt_td", "open_tgt", 0.02),
    }
    ctx["has_rz"] = bool(lt)
    return ctx


def usage_points(r: dict, rz: dict, ctx: dict) -> float:
    """Half-PPR points a league-average player would score with this usage."""
    pos = r["position"]
    td = ctx["td"]
    tgt, car, att = r["targets"], r["carries"], r["attempts"]
    if ctx["has_rz"]:
        rz_t = min(rz.get("rz_tgt", 0), tgt)
        gl = min(rz.get("gl_car", 0), car)
        rzc = min(rz.get("rz_car", 0), car - gl)
    else:                                   # no play-by-play: assume typical mix
        rz_t, gl, rzc = tgt * 0.13, car * 0.04, car * 0.11
    return (
        tgt * (ctx["ypt"][pos] * 0.1 + ctx["catch"][pos] * 0.5)
        + 6 * (rz_t * td["rz_tgt"] + (tgt - rz_t) * td["open_tgt"])
        + car * ctx["ypc"][pos] * 0.1
        + 6 * (gl * td["gl_car"] + rzc * td["rz_car"] + (car - gl - rzc) * td["open_car"])
        + att * (ctx["ypa"] * 0.04 + ctx["pass_td_rate"] * 4 - ctx["int_rate"] * 2)
    )


# --------------------------------------------------------------------------
# per-player projection
# --------------------------------------------------------------------------
def team_volume(data: dict) -> dict:
    """Recency-weighted targets and carries per game for each team."""
    by_team = defaultdict(list)
    for (team, week), r in data["team_week"].items():
        by_team[team].append((week, r))
    out = {}
    for team, rows in by_team.items():
        rows.sort(key=lambda x: -x[0])
        w = recency_weights(len(rows))
        out[team] = {
            "targets": wavg([r["targets"] for _, r in rows], w),
            "carries": wavg([r["carries"] for _, r in rows], w),
            "weeks": [wk for wk, _ in rows],
        }
    return out


def project_skill(pid: str, pos: str, team: str | None, rows: list[dict], data: dict,
                  ctx: dict, vol: dict) -> dict:
    """Per-game projection for a QB/RB/WR/TE from his weekly usage rows."""
    rows = sorted(rows, key=lambda r: -r["week"])
    w = recency_weights(len(rows))
    shrink = sum(w) / (sum(w) + C.SAMPLE_SHRINK)
    tw = data["team_week"]
    rzrows = [data["rz"].get((pid, r["week"]), {}) for r in rows]

    # --- usage shares, recency weighted ------------------------------------
    ts = clamp(wavg([r["target_share"] for r in rows], w), 0, 1)
    ays = clamp(wavg([clamp(r["air_yards_share"], 0, 1) for r in rows], w), 0, 1)
    cs = clamp(wavg([
        r["carries"] / tw[(r["team"], r["week"])]["carries"]
        if tw.get((r["team"], r["week"]), {}).get("carries") else 0.0 for r in rows], w), 0, 1)

    snap_vals = [data["snaps"].get((pid, r["week"])) for r in rows]
    snap_known = [s for s in snap_vals if s is not None]
    snap_recent = snap_known[: C.TREND_RECENT_GAMES]
    snap = sum(snap_recent) / len(snap_recent) if snap_recent else None
    snap_season = sum(snap_known) / len(snap_known) if snap_known else None
    snap_mult = 1.0
    if snap is not None and len(snap_known) > C.TREND_RECENT_GAMES:
        snap_mult = clamp(1 + C.SNAP_TREND_WEIGHT * (snap - snap_season), *C.SNAP_TREND_RANGE)

    tv = vol.get(team) or vol.get(rows[0]["team"]) or {"targets": 33.0, "carries": 26.0}
    role = shrink * snap_mult
    tgt_pg = ts * tv["targets"] * role
    car_pg = cs * tv["carries"] * role
    att_pg = wavg([r["attempts"] for r in rows], w) * shrink if pos == "QB" else 0.0

    # --- efficiency, regressed to position average -------------------------
    S = lambda key: sum(r[key] for r in rows)  # noqa: E731
    tgt, car, att = S("targets"), S("carries"), S("attempts")
    air_adj = 1.0
    if ts > 0.03:
        air_adj = clamp(1 + C.AIR_YARDS_WEIGHT * (ays - ts) / ts, *C.AIR_YARDS_ADJ_RANGE)
    ypt = regress(S("receiving_yards"), tgt, ctx["ypt"][pos], C.REG_TARGETS) * air_adj
    catch = regress(S("receptions"), tgt, ctx["catch"][pos], C.REG_TARGETS)
    ypc = regress(S("rushing_yards"), car, ctx["ypc"][pos], C.REG_CARRIES)

    # --- touchdowns: mostly from WHERE the touches happen -------------------
    td = ctx["td"]
    wt = wavg([r["targets"] for r in rows], w)
    wc = wavg([r["carries"] for r in rows], w)
    if ctx["has_rz"]:
        rz_t_rate = min(1.0, wavg([z.get("rz_tgt", 0) for z in rzrows], w) / wt) if wt else 0.0
        gl_rate = min(1.0, wavg([z.get("gl_car", 0) for z in rzrows], w) / wc) if wc else 0.0
        rzc_rate = min(1.0 - gl_rate, wavg([z.get("rz_car", 0) for z in rzrows], w) / wc) if wc else 0.0
    else:
        rz_t_rate, gl_rate, rzc_rate = 0.13, 0.04, 0.11
    exp_rec_td = tgt_pg * (rz_t_rate * td["rz_tgt"] + (1 - rz_t_rate) * td["open_tgt"])
    exp_rush_td = car_pg * (gl_rate * td["gl_car"] + rzc_rate * td["rz_car"]
                            + (1 - gl_rate - rzc_rate) * td["open_car"])
    k = C.TD_EXPECTED_WEIGHT
    rec_td = k * exp_rec_td + (1 - k) * wavg([r["receiving_tds"] for r in rows], w) * role
    rush_td = k * exp_rush_td + (1 - k) * wavg([r["rushing_tds"] for r in rows], w) * role

    line = {
        "rec": tgt_pg * catch, "rec_yd": tgt_pg * ypt, "rec_td": rec_td,
        "rush_yd": car_pg * ypc, "rush_td": rush_td,
    }
    if pos == "QB":
        line["pass_yd"] = att_pg * regress(S("passing_yards"), att, ctx["ypa"], C.REG_PASS_ATT)
        line["pass_td"] = att_pg * regress(S("passing_tds"), att, ctx["pass_td_rate"], C.REG_PASS_ATT)
        line["int"] = att_pg * regress(S("passing_interceptions"), att, ctx["int_rate"], C.REG_PASS_ATT)

    # --- usage trend: last few games vs earlier (TD-luck free) --------------
    xs = [usage_points(r, z, ctx) for r, z in zip(rows, rzrows)]
    n = C.TREND_RECENT_GAMES
    trend = (sum(xs[:n]) / n - sum(xs[n:]) / len(xs[n:])) if len(xs) >= n + 2 else 0.0

    return {
        "ppg": [max(0.0, fantasy_points(line, C.PPR_VALUES[f])) for f in FORMATS],
        "usage": {
            "ts": ts, "ays": ays, "cs": cs, "snap": snap,
            "rz": wavg([z.get("rz_tgt", 0) + z.get("rz_car", 0) + z.get("gl_car", 0) for z in rzrows], w),
            "gl": wavg([z.get("gl_car", 0) for z in rzrows], w),
        },
        "trend": trend,
        "games": len(rows),
        "last_week": rows[0]["week"],
    }


def schedule_factors(data: dict, dst_points: dict) -> dict:
    """(defense, position) -> multiplier. >1 means an easier matchup."""
    allowed = defaultdict(float)
    for r in data["weekly"]:
        if r["opponent_team"]:
            pts = r["k_pts"] if r["position"] == "K" else r["fp_half"]
            allowed[(r["opponent_team"], r["position"])] += pts
    games_played = defaultdict(int)
    for (team, _w), r in data["team_week"].items():
        if r.get("opp"):
            games_played[r["opp"]] += 1          # r["opp"] was the defense that week
    for (team, week), pts in dst_points.items():
        opp = data["team_week"].get((team, week), {}).get("opp")
        if opp:
            allowed[(opp, "DST")] += pts         # "allowed" to DSTs by this offense
    out = {}
    for pos in list(SKILL) + ["K", "DST"]:
        teams = [t for t in games_played if games_played[t]]
        total_g = sum(games_played[t] for t in teams)
        if not total_g:
            continue
        lg = sum(allowed[(t, pos)] for t in teams) / total_g
        for t in teams:
            g = games_played[t]
            ratio = (allowed[(t, pos)] / g) / lg if lg else 1.0
            out[(t, pos)] = clamp(regress(g * ratio, g, 1.0, C.SCHEDULE_REG_GAMES), *C.SCHEDULE_RANGE)
    return out


# --------------------------------------------------------------------------
# the whole thing
# --------------------------------------------------------------------------
def build_players(data: dict) -> tuple[list[dict], dict]:
    today = dt.date.fromisoformat(data["today"])
    games = data["games"]
    notes = list(data.get("notes", []))

    ident = build_identity(data.get("sleeper"), data.get("rosters", []), today)
    if not data.get("sleeper"):
        apply_injury_reports(ident, data.get("injuries", []), games)

    ctx = league_context(data)
    vol = team_volume(data)

    # remaining schedule ----------------------------------------------------
    remaining = sorted({g["week"] for g in games if not g["played"] and g["week"] <= C.FANTASY_LAST_WEEK})
    opp_in = {}                              # (team, week) -> opponent, unplayed games only
    all_weeks = defaultdict(set)
    for g in games:
        all_weeks[g["home"]].add(g["week"])
        all_weeks[g["away"]].add(g["week"])
        if not g["played"]:
            opp_in[(g["home"], g["week"])] = g["away"]
            opp_in[(g["away"], g["week"])] = g["home"]
    season_weeks = {g["week"] for g in games}
    bye = {t: next(iter(sorted(season_weeks - wks)), None) for t, wks in all_weeks.items()}

    # D/ST weekly fantasy points ----------------------------------------------
    pa = {}
    for g in games:
        if g["played"]:
            pa[(g["home"], g["week"])] = g["away_score"]
            pa[(g["away"], g["week"])] = g["home_score"]
    d = C.DST_SCORING
    dst_points = {}
    for r in data.get("dst_weekly", []):
        key = (r["team"], int(r["week"]))
        if key in pa:
            dst_points[key] = (r["sacks"] * d["sack"] + r["ints"] * d["int"] + r["fum_rec"] * d["fumble_rec"]
                               + r["tds"] * d["td"] + r["safeties"] * d["safety"]
                               + dst_points_allowed_score(pa[key]))

    sched = schedule_factors(data, dst_points)

    def week_multipliers(team, pos, status, stale):
        avail = C.AVAILABILITY.get(status, 1.0) * (C.STALE_MULTIPLIER if stale else 1.0)
        out, first = [], True
        for wk in remaining:
            opp = opp_in.get((team, wk))
            if not opp:
                out.append(0.0)
                continue
            m = sched.get((opp, pos), 1.0) * avail
            if first and status == "Out":
                m = 0.0                       # ruled out: misses the next game
            first = False
            out.append(round(m, 3))
        return out

    rows_by_player = defaultdict(list)
    for r in data["weekly"]:
        rows_by_player[r["player_id"]].append(r)

    players = []
    # ---- QB / RB / WR / TE / K ------------------------------------------------
    k_rows_all = [r for r in data["weekly"] if r["position"] == "K"]
    k_avg = sum(r["k_pts"] for r in k_rows_all) / len(k_rows_all) if k_rows_all else 7.5

    ids = set(ident) | {pid for pid, rs in rows_by_player.items()}
    for pid in ids:
        rows = rows_by_player.get(pid, [])
        info = ident.get(pid)
        if info is None:                     # has stats but unknown to both identity sources
            last = max(rows, key=lambda r: r["week"])
            info = {"name": last["player_display_name"], "team": last["team"], "pos": last["position"],
                    "age": None, "status": None}
        pos, team = info["pos"], info["team"]
        if pos not in C.FANTASY_POSITIONS or not info.get("name"):
            continue
        rows = [r for r in rows if r["position"] == pos] or rows
        if not rows and not team:
            continue                         # no stats and no team: not relevant
        status = info["status"] if team else None

        if not rows:
            proj = {"ppg": [0.0, 0.0, 0.0], "usage": {}, "trend": 0.0, "games": 0, "last_week": 0}
        elif pos == "K":
            g = len(rows)
            ppg = regress(sum(r["k_pts"] for r in rows), g, k_avg, C.REG_GAMES_K_DST)
            proj = {"ppg": [ppg] * 3, "usage": {}, "trend": 0.0, "games": g,
                    "last_week": max(r["week"] for r in rows)}
        else:
            proj = project_skill(pid, pos, team, rows, data, ctx, vol)

        team_weeks = vol.get(team, {}).get("weeks", [])[: C.STALE_GAMES]
        stale = bool(rows) and status is None and len(team_weeks) == C.STALE_GAMES \
            and proj["last_week"] < min(team_weeks)

        age = info["age"]
        depth_rank = data.get("depth", {}).get(pid)
        age_next = (age if age is not None else C.DEFAULT_AGE[pos]) + 1
        ns_mult = age_multiplier(pos, age_next) * role_security(pos, depth_rank, age) * C.NEXT_SEASON_GAMES
        if pos == "K":
            r_ = C.NEXT_SEASON_K_DST_REGRESSION
            ns = [(p * (1 - r_) + k_avg * r_) * C.NEXT_SEASON_GAMES if proj["games"] else 0.0 for p in proj["ppg"]]
        else:
            ns = [p * ns_mult for p in proj["ppg"]]

        players.append({
            "id": pid, "n": info["name"], "p": pos, "t": team, "age": age, "st": status,
            "stale": stale, "ppg": proj["ppg"], "ns": ns, "u": proj["usage"], "tr": proj["trend"],
            "g": proj["games"], "dr": depth_rank,
            "wk": week_multipliers(team, pos, status, stale) if team else [0.0] * len(remaining),
        })

    # ---- D/ST -------------------------------------------------------------------
    by_team = defaultdict(list)
    for (team, _wk), pts in dst_points.items():
        by_team[team].append(pts)
    all_dst = [p for v in by_team.values() for p in v]
    dst_avg = sum(all_dst) / len(all_dst) if all_dst else 7.0
    for team, pts in by_team.items():
        ppg = regress(sum(pts), len(pts), dst_avg, C.REG_GAMES_K_DST)
        r_ = C.NEXT_SEASON_K_DST_REGRESSION
        nick = data.get("team_names", {}).get(team, team)
        players.append({
            "id": f"DST_{team}", "n": f"{nick} D/ST", "p": "DST", "t": team, "age": None, "st": None,
            "stale": False, "ppg": [ppg] * 3, "ns": [(ppg * (1 - r_) + dst_avg * r_) * C.NEXT_SEASON_GAMES] * 3,
            "u": {}, "tr": 0.0, "g": len(pts), "dr": None,
            "wk": week_multipliers(team, "DST", None, False),
        })
    if not by_team:
        notes.append("Team defenses (D/ST) could not be valued in this update.")

    # ---- role openings: is the player ahead of you hurt? -------------------------
    groups = defaultdict(list)
    for p in players:
        if p["t"] and p["p"] in SKILL:
            groups[(p["t"], p["p"])].append(p)
    for grp in groups.values():
        grp.sort(key=lambda p: -p["ppg"][1])
        for i, hurt in enumerate(grp):
            if hurt["st"] in HURT and hurt["ppg"][1] >= 6:
                for nxt in grp[i + 1: i + 3]:
                    if nxt["st"] not in HURT and not nxt.get("open"):
                        nxt["open"] = f"{hurt['n']} is {hurt['st']}"

    # ---- tidy up ---------------------------------------------------------------
    for p in players:
        p["bye"] = bye.get(p["t"])
        p["t"] = TEAM_DISPLAY.get(p["t"], p["t"]) or "FA"
        p["ppg"] = [round(x, 2) for x in p["ppg"]]
        p["ns"] = [round(x, 1) for x in p["ns"]]
        p["tr"] = round(p["tr"], 2)
        p["u"] = {k: round(v, 3) for k, v in p["u"].items() if v is not None}
        p["age"] = p["age"]
        if not p["stale"]:
            del p["stale"]
        for key in ("st", "dr", "age", "bye"):
            if p[key] is None:
                del p[key]
    players.sort(key=lambda p: -(p["ppg"][0] * sum(p["wk"])))

    data_week = max((r["week"] for r in data["weekly"]), default=0)
    if not ctx["has_rz"]:
        notes.append("Red-zone data was unavailable; touchdowns were estimated from overall usage.")
    if not data.get("snaps"):
        notes.append("Snap-share trends are not included in this update.")
    if not data.get("depth"):
        notes.append("Depth charts were unavailable; keeper role-security uses a default.")
    meta = {
        "season": data["season"],
        "week": data_week,
        "weekPartial": any(g["week"] == data_week and not g["played"] for g in games),
        "generated": data["today"],
        "weeks": remaining,
        "formats": list(FORMATS),
        "identitySource": "Sleeper" if data.get("sleeper") else "nflverse rosters",
        "notes": notes,
        "config": C.PAGE_CONFIG,
        "sources": [
            {"name": "nflverse (nflreadpy): weekly stats, play-by-play, snaps, schedules, injuries, depth charts",
             "url": "https://github.com/nflverse", "license": "CC-BY 4.0"},
            {"name": "Sleeper public API: player names, teams, positions, ages, injury status",
             "url": "https://docs.sleeper.com/"},
        ],
    }
    return players, meta
