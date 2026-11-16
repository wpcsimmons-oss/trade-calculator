"""Run with:  python -m pytest -q"""
import copy
import datetime as dt

from pipeline import config as C
from pipeline import engine, validate
from tests.helpers import make_data


def by_id(players):
    return {p["id"]: p for p in players}


# ---------------- value math ----------------
def test_recency_weights_favor_recent_games():
    w = engine.recency_weights(8)
    assert w[:C.RECENCY_FULL_GAMES] == [1.0] * C.RECENCY_FULL_GAMES
    assert all(a > b for a, b in zip(w[C.RECENCY_FULL_GAMES - 1:], w[C.RECENCY_FULL_GAMES:]))


def test_regress_pulls_toward_league_average():
    lucky = engine.regress(numer=300, denom=20, league_rate=8.0, k=80)   # 15 yards/target on 20 targets
    assert 8.0 < lucky < 10.0
    assert engine.regress(0, 0, 8.0, 80) == 8.0


def test_age_curve_and_role_security():
    assert engine.age_multiplier("RB", 24) > engine.age_multiplier("RB", 29) > engine.age_multiplier("RB", 32)
    assert engine.age_multiplier("QB", 30) > engine.age_multiplier("RB", 30)
    assert engine.role_security("RB", 1, 27) > engine.role_security("RB", 2, 27) > engine.role_security("RB", 4, 27)
    assert engine.role_security("RB", 2, 22) > engine.role_security("RB", 2, 28)   # young backups move up


def test_more_usage_means_more_value_and_formats_are_ordered():
    players, meta = engine.build_players(make_data())
    p = by_id(players)
    assert p["AAA-WR1"]["ppg"][0] > p["AAA-WR2"]["ppg"][0] > p["AAA-WR3"]["ppg"][0]
    assert p["AAA-RB1"]["ppg"][0] > p["AAA-RB2"]["ppg"][0]
    for pl in players:
        ppr, half, std = pl["ppg"]
        assert ppr >= half >= std >= 0
    assert meta["weeks"] == list(range(7, 18))
    assert meta["week"] == 6


def test_touchdown_luck_is_mostly_removed():
    def lucky(d):
        for r in d["weekly"]:
            if r["player_id"] == "BBB-WR2":
                r["receiving_tds"] = 2          # 12 TDs in 6 games on the same usage as AAA-WR2
    p = by_id(engine.build_players(make_data(tweak=lucky))[0])
    gap = p["BBB-WR2"]["ppg"][2] - p["AAA-WR2"]["ppg"][2]
    assert 0 < gap < 0.35 * (2 * 6)             # raw gap would be 12 points per game


def test_red_zone_role_adds_value():
    def goal_line(d):
        for w in range(1, 7):
            d["rz"][("AAA-RB2", w)] = dict(gl_car=3, rz_car=1, rz_tgt=0)
    base = by_id(engine.build_players(make_data())[0])["AAA-RB2"]["ppg"][2]
    boosted = by_id(engine.build_players(make_data(tweak=goal_line))[0])["AAA-RB2"]["ppg"][2]
    assert boosted > base + 1


def test_bye_weeks_and_injuries_reduce_remaining_value():
    def hurt(d):
        for r in d["rosters"]:
            if r["gsis_id"] == "BBB-WR1":
                r["status"] = "RES"
    players, meta = engine.build_players(make_data(tweak=hurt))
    p = by_id(players)
    bye_idx = meta["weeks"].index(8)
    assert p["AAA-WR1"]["wk"][bye_idx] == 0 and p["AAA-WR1"]["bye"] == 8
    assert p["BBB-WR1"]["st"] == "IR"
    assert sum(p["BBB-WR1"]["wk"]) < 0.5 * sum(p["CCC-WR1"]["wk"])
    assert p["BBB-WR2"].get("open", "").startswith("BBB Alpha")       # role opening flagged


def test_stale_role_is_discounted():
    def vanished(d):
        d["weekly"] = [r for r in d["weekly"] if not (r["player_id"] == "CCC-RB2" and r["week"] >= 4)]
    p = by_id(engine.build_players(make_data(tweak=vanished))[0])
    assert p["CCC-RB2"].get("stale") is True
    assert max(p["CCC-RB2"]["wk"]) <= C.STALE_MULTIPLIER * C.SCHEDULE_RANGE[1]


def test_next_season_value_favors_the_young():
    p = by_id(engine.build_players(make_data())[0])
    # WR2 is 30, WR3 is 24: WR2 produces more now but ages worse
    assert p["AAA-WR2"]["ns"][0] / p["AAA-WR2"]["ppg"][0] < p["AAA-WR3"]["ns"][0] / p["AAA-WR3"]["ppg"][0]


# ---------------- Sleeper identity ----------------
def test_sleeper_identity_wins_and_falls_back():
    today = dt.date(2026, 10, 20)
    rosters = [
        dict(gsis_id="00-1", full_name="Old Name", team="AAA", position="WR", status="ACT", birth_date="2000-01-01", sleeper_id="111"),
        dict(gsis_id="00-2", full_name="Only Nflverse", team="BBB", position="RB", status="RES", birth_date="1999-01-01", sleeper_id=None),
        dict(gsis_id="00-3", full_name="A.J. Match Jr.", team="CCC", position="TE", status="ACT", birth_date=None, sleeper_id=None),
        dict(gsis_id="00-4", full_name="Some Guard", team="AAA", position="G", status="ACT", birth_date=None, sleeper_id=None),
    ]
    sleeper = {
        "111": dict(full_name="New Name", team="LAR", position="WR", birth_date="2000-01-01", injury_status="Questionable", active=True),
        "222": dict(full_name="AJ Match", team="CCC", position="TE", age=25, active=True, gsis_id=None),
        "333": dict(full_name="Line Backer", team="AAA", position="LB", active=True),
        "KC": dict(first_name="Kansas City", last_name="Chiefs", team="KC", position="DEF", active=True),
    }
    ident = engine.build_identity(sleeper, rosters, today)
    assert ident["00-1"]["name"] == "New Name" and ident["00-1"]["team"] == "LA" and ident["00-1"]["status"] == "Questionable"
    assert ident["00-2"]["status"] == "IR" and ident["00-2"]["name"] == "Only Nflverse"
    assert ident["00-3"]["name"] == "AJ Match" and ident["00-3"]["age"] == 25      # matched by name
    assert set(ident) == {"00-1", "00-2", "00-3"}
    assert set(engine.build_identity(None, rosters, today)) == {"00-1", "00-2", "00-3"}


# ---------------- data safety checks ----------------
def test_small_league_fails_minimum_player_check():
    players, meta = engine.build_players(make_data())
    errors = validate.check_output(players, meta)
    assert any("minimum" in e for e in errors)


def _passing_output():
    """Pad the toy league out to a realistic size so only the thing under test fails."""
    players, meta = engine.build_players(make_data())
    out = []
    for i in range(12):
        for p in players:
            q = copy.deepcopy(p)
            q["id"] = f"{p['id']}-{i}"
            q["t"] = f"T{i}{p['t']}"
            out.append(q)
    return out, meta


def test_realistic_output_passes_then_bad_values_fail():
    players, meta = _passing_output()
    assert validate.check_output(players, meta) == []

    bad = copy.deepcopy(players)
    bad[0]["u"]["ts"] = 1.4
    assert any("outside 0-1" in e for e in validate.check_output(bad, meta))

    bad = copy.deepcopy(players)
    bad[0]["ppg"] = [float("nan")] * 3
    assert validate.check_output(bad, meta)

    bad = copy.deepcopy(players)
    bad[1]["id"] = bad[0]["id"]
    assert any("Duplicate" in e for e in validate.check_output(bad, meta))

    assert validate.check_output(players[:150], meta)


def test_raw_share_outside_range_fails():
    data = make_data()
    data["weekly"][0]["target_share"] = 1.7
    assert any("target share" in e for e in validate.check_raw(data))


def test_stale_data_fails_freshness_check():
    assert validate.check_freshness(make_data(today="2026-10-20")) == []      # week 6 just finished
    stale = validate.check_freshness(make_data(today="2026-11-10"))           # weeks 7-9 "happened", no stats
    assert stale and "stale" in stale[0]


def test_last_completed_week_waits_a_day():
    games = make_data()["games"]
    assert engine.last_completed_week(games, dt.date(2026, 9, 13)) == 0       # game day itself
    assert engine.last_completed_week(games, dt.date(2026, 9, 14)) == 1
