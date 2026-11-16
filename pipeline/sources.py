"""
Downloads the raw data and boils it down to plain Python lists/dicts.

Sources
-------
* nflverse (via the nflreadpy package): weekly player stats, play-by-play
  (for red-zone touches), snap counts, schedules, injuries, depth charts,
  rosters, team stats.
* Sleeper public API: player names, teams, positions, ages, injury status.

Every optional source is wrapped so that if it is unavailable the pipeline
keeps going and records a note that is shown on the web page.
"""
from __future__ import annotations

import datetime as dt
import json
import urllib.request

import polars as pl

from . import config as C

SKILL = ["QB", "RB", "WR", "TE"]


def _try(notes: list, label: str, fn, required: bool = False):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - we really do want to catch everything
        if required:
            raise RuntimeError(f"Required data source failed: {label}: {e!r}") from e
        notes.append(f"{label} was unavailable for this update, so it was skipped.")
        print(f"[warn] {label} unavailable: {e!r}"[:300])
        return None


def fetch_sleeper(url: str = C.SLEEPER_PLAYERS_URL, timeout: int = 60) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "fantasy-trade-calculator"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))
    if not isinstance(data, dict) or len(data) < 1000:
        raise ValueError("Sleeper response did not look like the player list")
    return data


def _f(col: str) -> pl.Expr:
    return pl.col(col).cast(pl.Float64, strict=False).fill_null(0.0)


def load_all(today: dt.date | None = None) -> dict:
    """Download everything. Returns a dict of plain data the engine understands."""
    import nflreadpy as nfl

    today = today or dt.datetime.now(dt.timezone.utc).date()
    notes: list[str] = []
    season = nfl.get_current_season()

    # ---- schedule (required) ------------------------------------------------
    sched = _try(notes, "Schedule", lambda: nfl.load_schedules(season), required=True)
    sched = sched.filter(pl.col("game_type") == "REG")
    games = [
        {
            "week": int(g["week"]),
            "home": g["home_team"],
            "away": g["away_team"],
            "date": str(g["gameday"]),
            "played": g["home_score"] is not None,
            "home_score": g["home_score"],
            "away_score": g["away_score"],
        }
        for g in sched.select(
            ["week", "home_team", "away_team", "gameday", "home_score", "away_score"]
        ).to_dicts()
    ]

    # ---- weekly player stats (required) -------------------------------------
    ps = _try(notes, "Weekly player stats", lambda: nfl.load_player_stats(season), required=True)
    ps = ps.filter(pl.col("season_type") == "REG")
    k = C.KICKER_SCORING
    ps = ps.with_columns(
        fum_lost=_f("sack_fumbles_lost") + _f("rushing_fumbles_lost") + _f("receiving_fumbles_lost"),
        fp_half=(_f("fantasy_points") + _f("fantasy_points_ppr")) / 2,
        k_pts=(
            _f("pat_made") * k["pat"]
            + (_f("fg_made_0_19") + _f("fg_made_20_29") + _f("fg_made_30_39")) * k["fg_0_39"]
            + _f("fg_made_40_49") * k["fg_40_49"]
            + (_f("fg_made_50_59") + _f("fg_made_60_")) * k["fg_50_plus"]
        ),
    )
    keep = [
        "player_id", "player_display_name", "position", "team", "opponent_team", "week",
        "attempts", "passing_yards", "passing_tds", "passing_interceptions",
        "carries", "rushing_yards", "rushing_tds",
        "targets", "receptions", "receiving_yards", "receiving_tds",
        "target_share", "air_yards_share", "wopr", "fum_lost", "fp_half", "k_pts",
    ]
    weekly = ps.filter(pl.col("position").is_in(C.FANTASY_POSITIONS)).select(keep).to_dicts()
    for r in weekly:
        for key, v in r.items():
            if v is None and key not in ("player_id", "player_display_name", "position", "team", "opponent_team"):
                r[key] = 0

    # team totals per week come from ALL players (not just fantasy positions)
    team_week = {
        (r["team"], int(r["week"])): r
        for r in ps.group_by(["team", "week"])
        .agg(_f("carries").sum().alias("carries"), _f("attempts").sum().alias("attempts"),
             _f("targets").sum().alias("targets"), pl.col("opponent_team").first().alias("opp"))
        .to_dicts()
    }

    # ---- play-by-play: red-zone and goal-line touches (optional) ------------
    rz: dict = {}
    league_td = None

    def _pbp():
        p = nfl.load_pbp(season).filter(
            (pl.col("season_type") == "REG") & (_f("two_point_attempt") == 0)
            & pl.col("yardline_100").is_not_null()
        )
        zone = (
            pl.when(pl.col("yardline_100") <= C.GOAL_LINE_YARDLINE).then(pl.lit("gl"))
            .when(pl.col("yardline_100") <= C.RED_ZONE_YARDLINE).then(pl.lit("rz"))
            .otherwise(pl.lit("open"))
        )
        rush = p.filter(pl.col("rusher_player_id").is_not_null() & (_f("rush_attempt") == 1)
                        & (_f("qb_kneel") == 0)).with_columns(zone=zone)
        tgt = p.filter(pl.col("receiver_player_id").is_not_null() & (_f("pass_attempt") == 1)
                       & (_f("sack") == 0)).with_columns(zone=zone)
        out: dict = {}
        for r in rush.group_by(["rusher_player_id", "week", "zone"]).len().to_dicts():
            d = out.setdefault((r["rusher_player_id"], int(r["week"])), {"gl_car": 0, "rz_car": 0, "rz_tgt": 0})
            if r["zone"] == "gl":
                d["gl_car"] += r["len"]
            elif r["zone"] == "rz":
                d["rz_car"] += r["len"]
        for r in tgt.group_by(["receiver_player_id", "week", "zone"]).len().to_dicts():
            d = out.setdefault((r["receiver_player_id"], int(r["week"])), {"gl_car": 0, "rz_car": 0, "rz_tgt": 0})
            if r["zone"] in ("gl", "rz"):
                d["rz_tgt"] += r["len"]
        lt = {}
        for r in rush.group_by("zone").agg(pl.len().alias("n"), _f("rush_touchdown").sum().alias("td")).to_dicts():
            lt[f"{r['zone']}_car"] = r["n"]
            lt[f"{r['zone']}_car_td"] = r["td"]
        tz = tgt.with_columns(z2=pl.when(pl.col("zone") == "open").then(pl.lit("open")).otherwise(pl.lit("rz")))
        for r in tz.group_by("z2").agg(pl.len().alias("n"), _f("pass_touchdown").sum().alias("td")).to_dicts():
            lt[f"{r['z2']}_tgt"] = r["n"]
            lt[f"{r['z2']}_tgt_td"] = r["td"]
        return out, lt

    res = _try(notes, "Play-by-play (red-zone and goal-line touches)", _pbp)
    if res:
        rz, league_td = res

    # ---- snap counts (optional) ---------------------------------------------
    snaps: dict = {}

    def _snaps():
        s = nfl.load_snap_counts(season).filter(pl.col("game_type") == "REG")
        ids = nfl.load_players().filter(pl.col("pfr_id").is_not_null()).select(["pfr_id", "gsis_id"])
        s = s.join(ids, left_on="pfr_player_id", right_on="pfr_id", how="inner")
        return {
            (r["gsis_id"], int(r["week"])): float(r["offense_pct"] or 0)
            for r in s.select(["gsis_id", "week", "offense_pct"]).to_dicts()
            if r["gsis_id"]
        }

    snaps = _try(notes, "Snap counts", _snaps) or {}

    # ---- team defense stats (optional -> no DST if missing) -----------------
    dst_weekly: list = []

    def _dst():
        t = nfl.load_team_stats(season).filter(pl.col("season_type") == "REG")
        return t.select(
            "team", "week", "opponent_team",
            _f("def_sacks").alias("sacks"), _f("def_interceptions").alias("ints"),
            _f("fumble_recovery_opp").alias("fum_rec"),
            (_f("def_tds") + _f("special_teams_tds")).alias("tds"),
            _f("def_safeties").alias("safeties"),
        ).to_dicts()

    dst_weekly = _try(notes, "Team defense stats (D/ST values)", _dst) or []

    # ---- team names -----------------------------------------------------------
    team_names = {}
    tn = _try(notes, "Team names", lambda: nfl.load_teams().select(["team_abbr", "team_nick"]).to_dicts())
    if tn:
        team_names = {r["team_abbr"]: r["team_nick"] for r in tn}

    # ---- rosters (ids, birth dates, roster status; fallback identity) -------
    rosters = _try(
        notes, "nflverse rosters",
        lambda: nfl.load_rosters(season).select(
            ["gsis_id", "full_name", "team", "position", "status", "birth_date", "sleeper_id", "years_exp"]
        ).to_dicts(),
    ) or []
    for r in rosters:
        r["birth_date"] = str(r["birth_date"]) if r["birth_date"] else None

    # ---- injuries (optional) -------------------------------------------------
    def _inj():
        i = nfl.load_injuries(season).filter(pl.col("report_status").is_not_null())
        return i.select(["gsis_id", "team", "week", "report_status"]).to_dicts()

    injuries = _try(notes, "Injury reports", _inj) or []

    # ---- depth charts (optional) ---------------------------------------------
    def _depth():
        d = nfl.load_depth_charts(season)
        latest = d.group_by("team").agg(pl.col("dt").max().alias("mx"))
        d = d.join(latest, on="team").filter(pl.col("dt") == pl.col("mx"))
        d = d.filter(pl.col("pos_abb").is_in(["QB", "RB", "WR", "TE", "K", "PK"]) & pl.col("gsis_id").is_not_null())
        out = {}
        for r in d.select(["gsis_id", "pos_rank"]).to_dicts():
            rank = int(r["pos_rank"] or 9)
            out[r["gsis_id"]] = min(rank, out.get(r["gsis_id"], 99))
        return out

    depth = _try(notes, "Depth charts", _depth) or {}

    # ---- Sleeper (optional: falls back to nflverse rosters) -----------------
    sleeper = _try(notes, "Sleeper player list (names/teams/ages now come from nflverse rosters instead)",
                   fetch_sleeper)

    return {
        "season": int(season),
        "today": today.isoformat(),
        "games": games,
        "weekly": weekly,
        "team_week": team_week,
        "rz": rz,
        "league_td": league_td,
        "snaps": snaps,
        "dst_weekly": dst_weekly,
        "team_names": team_names,
        "rosters": rosters,
        "injuries": injuries,
        "depth": depth,
        "sleeper": sleeper,
        "notes": notes,
    }
