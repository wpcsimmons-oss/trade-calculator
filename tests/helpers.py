"""A tiny made-up league used by the tests (no downloads needed)."""
import datetime as dt

TEAMS = ["AAA", "BBB", "CCC", "DDD"]
PLAYED_WEEKS = [1, 2, 3, 4, 5, 6]


def row(pid, name, pos, team, opp, week, **kw):
    base = dict(player_id=pid, player_display_name=name, position=pos, team=team, opponent_team=opp,
                week=week, attempts=0, passing_yards=0, passing_tds=0, passing_interceptions=0,
                carries=0, rushing_yards=0, rushing_tds=0, targets=0, receptions=0, receiving_yards=0,
                receiving_tds=0, target_share=0.0, air_yards_share=0.0, wopr=0.0, fum_lost=0,
                fp_half=0.0, k_pts=0.0)
    base.update(kw)
    return base


def make_data(today="2026-10-20", tweak=None):
    """4 teams. Weeks 1-6 played, weeks 7-17 still to come. AAA has a bye in week 8."""
    games, weekly, team_week, rosters = [], [], {}, []
    pair_a, pair_b = [("AAA", "BBB"), ("CCC", "DDD")], [("AAA", "CCC"), ("BBB", "DDD")]
    start = dt.date(2026, 9, 13)
    for week in range(1, 19):
        pairs = pair_a if week % 2 else pair_b
        for home, away in pairs:
            if week == 8 and "AAA" in (home, away):
                continue
            played = week in PLAYED_WEEKS
            games.append(dict(week=week, home=home, away=away, played=played,
                              date=(start + dt.timedelta(days=7 * (week - 1))).isoformat(),
                              home_score=24 if played else None, away_score=17 if played else None))
    for g in games:
        if not g["played"]:
            continue
        for team, opp in ((g["home"], g["away"]), (g["away"], g["home"])):
            wk = g["week"]
            team_week[(team, wk)] = dict(carries=25, attempts=35, targets=33, opp=opp)
            weekly += [
                row(f"{team}-QB", f"{team} Quarterback", "QB", team, opp, wk, attempts=35, passing_yards=250,
                    passing_tds=2, passing_interceptions=1, carries=3, rushing_yards=12, fp_half=18),
                row(f"{team}-RB1", f"{team} Starter", "RB", team, opp, wk, carries=17, rushing_yards=75,
                    rushing_tds=1, targets=4, receptions=3, receiving_yards=22, target_share=4 / 33, fp_half=17),
                row(f"{team}-RB2", f"{team} Backup", "RB", team, opp, wk, carries=5, rushing_yards=20,
                    targets=2, receptions=1, receiving_yards=8, target_share=2 / 33, fp_half=3.3),
                row(f"{team}-WR1", f"{team} Alpha", "WR", team, opp, wk, targets=10, receptions=7,
                    receiving_yards=90, receiving_tds=1, target_share=10 / 33, air_yards_share=0.4, fp_half=18.5),
                row(f"{team}-WR2", f"{team} Second", "WR", team, opp, wk, targets=7, receptions=4,
                    receiving_yards=50, target_share=7 / 33, air_yards_share=0.25, fp_half=7),
                row(f"{team}-WR3", f"{team} Third", "WR", team, opp, wk, targets=4, receptions=2,
                    receiving_yards=25, target_share=4 / 33, air_yards_share=0.15, fp_half=3.5),
                row(f"{team}-TE", f"{team} Tightend", "TE", team, opp, wk, targets=6, receptions=4,
                    receiving_yards=40, target_share=6 / 33, air_yards_share=0.2, fp_half=6),
                row(f"{team}-K", f"{team} Kicker", "K", team, opp, wk, k_pts=8.0),
            ]
    for team in TEAMS:
        for suffix, pos, birth in [("QB", "QB", "1998-01-01"), ("RB1", "RB", "2001-01-01"), ("RB2", "RB", "2003-06-01"),
                                   ("WR1", "WR", "2000-01-01"), ("WR2", "WR", "1996-01-01"), ("WR3", "WR", "2002-01-01"),
                                   ("TE", "TE", "1999-01-01"), ("K", "K", "1995-01-01")]:
            rosters.append(dict(gsis_id=f"{team}-{suffix}", full_name=None, team=team, position=pos, status="ACT",
                                birth_date=birth, sleeper_id=None, years_exp=3))
    names = {r["player_id"]: r["player_display_name"] for r in weekly}
    for r in rosters:
        r["full_name"] = names[r["gsis_id"]]
    data = dict(season=2026, today=today, games=games, weekly=weekly, team_week=team_week, rz={},
                league_td=dict(gl_car=100, gl_car_td=40, rz_car=300, rz_car_td=20, open_car=2000, open_car_td=10,
                               rz_tgt=400, rz_tgt_td=90, open_tgt=2500, open_tgt_td=45),
                snaps={}, dst_weekly=[dict(team=t, week=w, opponent_team="x", sacks=2, ints=1, fum_rec=0, tds=0, safeties=0)
                                      for t in TEAMS for w in PLAYED_WEEKS],
                team_names={t: t.title() for t in TEAMS}, rosters=rosters, injuries=[], depth={}, sleeper=None, notes=[])
    if tweak:
        tweak(data)
    return data
