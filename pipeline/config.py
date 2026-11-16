"""
ALL TUNABLE NUMBERS LIVE HERE.
==============================
Every formula weight used by the pipeline (and the handful the web page needs,
which are copied into players.json under "meta.config") is in this one file.
Change a number, run the pipeline (or just push to GitHub and the workflow
re-runs), and every value on the site updates.

Nothing in here is secret. Nothing in here needs a password or API key.
"""

# ---------------------------------------------------------------------------
# 1. SEASON CALENDAR
# ---------------------------------------------------------------------------
FANTASY_LAST_WEEK = 17          # most leagues end in week 17 (week 18 is ignored)
PLAYOFF_WEEKS = [15, 16, 17]    # fantasy playoff weeks
PLAYOFF_WEEK_WEIGHT = 1.5       # a point scored in a playoff week counts 1.5x
                                # when the page ranks players by "value"

# ---------------------------------------------------------------------------
# 2. RECENCY WEIGHTING  ("weighted toward the last 3-4 weeks")
# ---------------------------------------------------------------------------
# A player's most recent RECENCY_FULL_GAMES games each count fully (weight 1).
# Each game older than that counts RECENCY_DECAY times the one after it.
RECENCY_FULL_GAMES = 4
RECENCY_DECAY = 0.75

# Small-sample protection: usage is multiplied by  w / (w + SAMPLE_SHRINK)
# where w is the total recency weight of the games played. A player with one
# big game is therefore trusted far less than one with six.
SAMPLE_SHRINK = 0.6

# ---------------------------------------------------------------------------
# 3. EFFICIENCY REGRESSION  ("pull efficiency back toward league average")
# ---------------------------------------------------------------------------
# Each number is "how many league-average attempts we mix in". Bigger number =
# trust the player's own efficiency less. Example: a WR with 50 targets and
# REG_TARGETS = 80 gets a yards-per-target that is 50/130 his own, 80/130
# league average for his position.
REG_TARGETS = 80        # yards per target and catch rate
REG_CARRIES = 100       # yards per carry
REG_PASS_ATT = 200      # QB yards per attempt, TD rate, INT rate
REG_GAMES_K_DST = 6     # kickers and defenses: league-average games mixed in

# Touchdowns are mostly luck in small samples. Projected TDs are
#   TD_EXPECTED_WEIGHT * (TDs expected from where the touches happened)
# + (1 - TD_EXPECTED_WEIGHT) * (the player's actual TD pace)
TD_EXPECTED_WEIGHT = 0.8

# Air yards: a player whose share of team air yards is higher than his share of
# targets is being thrown deeper passes, which are worth more yards each.
# yards-per-target is nudged by AIR_YARDS_WEIGHT * (air share - target share)
# / target share, limited to the range below.
AIR_YARDS_WEIGHT = 0.25
AIR_YARDS_ADJ_RANGE = (0.88, 1.18)

# Snap share: if recent snap share is above/below the season average the role
# is growing/shrinking. Usage is multiplied by
#   1 + SNAP_TREND_WEIGHT * (recent snap share - season snap share)
SNAP_TREND_WEIGHT = 0.5
SNAP_TREND_RANGE = (0.85, 1.15)
TREND_RECENT_GAMES = 3          # "recent" = last 3 games, for trend arrows

# Red zone = inside the opponent's 20-yard line. Goal line = inside the 5.
RED_ZONE_YARDLINE = 20
GOAL_LINE_YARDLINE = 5

# ---------------------------------------------------------------------------
# 4. SCHEDULE ADJUSTMENT
# ---------------------------------------------------------------------------
# For each defense we measure fantasy points allowed to each position compared
# with league average (1.00 = average, 1.10 = gives up 10% more).
# It is regressed with SCHEDULE_REG_GAMES average games and capped.
SCHEDULE_REG_GAMES = 8
SCHEDULE_RANGE = (0.85, 1.15)

# ---------------------------------------------------------------------------
# 5. AVAILABILITY (injuries / stale roles)
# ---------------------------------------------------------------------------
# Multiplier applied to every remaining week for a player with this status.
AVAILABILITY = {
    "IR": 0.25,           # on injured reserve - may or may not return
    "PUP": 0.25,
    "Sus": 0.40,          # suspended
    "Out": 0.85,          # ruled out this week (next game is also zeroed)
    "Doubtful": 0.90,
    "Questionable": 0.97,
    "Inactive": 0.60,     # not on the active roster (cut, practice squad...)
}
# If a player has no injury tag but has not appeared in his team's last
# STALE_GAMES games, he has probably lost his role.
STALE_GAMES = 3
STALE_MULTIPLIER = 0.45

# ---------------------------------------------------------------------------
# 6. FANTASY SCORING  (the three formats only differ by points per reception)
# ---------------------------------------------------------------------------
SCORING = {
    "pass_yd": 0.04, "pass_td": 4, "int": -2,
    "rush_yd": 0.1, "rush_td": 6,
    "rec_yd": 0.1, "rec_td": 6,
    "fumble_lost": -2,
}
PPR_VALUES = {"ppr": 1.0, "half": 0.5, "std": 0.0}

KICKER_SCORING = {"pat": 1, "fg_0_39": 3, "fg_40_49": 4, "fg_50_plus": 5}
DST_SCORING = {"sack": 1, "int": 2, "fumble_rec": 2, "td": 6, "safety": 2}
# points allowed -> fantasy points (upper bound of bracket, points)
DST_POINTS_ALLOWED = [(0, 10), (6, 7), (13, 4), (20, 1), (27, 0), (34, -1), (999, -4)]

# ---------------------------------------------------------------------------
# 7. KEEPER MODE: NEXT-SEASON VALUE
# ---------------------------------------------------------------------------
# Multiplier on per-game production for a player who will be this age next
# season. Ages between the listed ones are interpolated.
AGE_CURVES = {
    "QB": {22: 1.05, 25: 1.05, 28: 1.02, 32: 1.00, 35: 0.93, 38: 0.80, 41: 0.60},
    "RB": {21: 1.08, 23: 1.06, 25: 1.00, 26: 0.95, 27: 0.89, 28: 0.82, 29: 0.74, 30: 0.65, 32: 0.45},
    "WR": {21: 1.12, 23: 1.10, 25: 1.05, 27: 1.00, 29: 0.95, 30: 0.90, 31: 0.84, 32: 0.76, 34: 0.58},
    "TE": {22: 1.12, 24: 1.10, 26: 1.04, 28: 1.00, 30: 0.94, 32: 0.84, 34: 0.68},
    "K":  {22: 1.00, 40: 1.00},
    "DST": {0: 1.00, 99: 1.00},
}
DEFAULT_AGE = {"QB": 28, "RB": 26, "WR": 26, "TE": 27, "K": 30, "DST": 0}  # if age unknown

# Role security: how sure are we the player keeps this job next year?
# Based on depth-chart rank at his position (1 = starter).
ROLE_SECURITY_BY_DEPTH = {1: 1.00, 2: 0.88, 3: 0.78}
ROLE_SECURITY_DEFAULT = 0.72        # deeper than 3rd string / unknown
# Young players behind a starter tend to move up; give them some of it back.
YOUNG_AGE = 24
YOUNG_ROLE_BONUS = 0.08
NEXT_SEASON_GAMES = 15              # expected games played out of 17
# K and DST barely carry over year to year: pull them hard to league average.
NEXT_SEASON_K_DST_REGRESSION = 0.7

# ---------------------------------------------------------------------------
# 8. NUMBERS THE WEB PAGE USES (copied into players.json -> meta.config)
# ---------------------------------------------------------------------------
PAGE_CONFIG = {
    "playoffWeeks": PLAYOFF_WEEKS,
    "playoffWeight": PLAYOFF_WEEK_WEIGHT,
    # Replacement level = the best player you could expect to find on waivers.
    # The page counts league-wide starters at each position, then adds this
    # share of all bench spots, and the next player down is "replacement".
    "benchShare": {"QB": 0.10, "RB": 0.40, "WR": 0.38, "TE": 0.10, "K": 0.01, "DST": 0.01},
    # Trade score = change in starting-lineup points
    #             + benchDepthWeight * change in bench value (depth/insurance).
    "benchDepthWeight": 0.15,
    # A trade within this many points per remaining week is called "even".
    "evenTradePerWeek": 0.5,
    # Keeper mode: keeper value = rosWeight * ROS value + nextWeight * next-season value
    "keeperRosWeight": 0.4,
    "keeperNextWeight": 0.6,
    # Waiver score = lineup gain + waiverVorWeight * value over replacement
    #              + trend and role-opening bonuses (in fantasy points)
    "waiverVorWeight": 0.35,
    "waiverTrendWeight": 1.5,       # points of score per +1 pt/game usage trend
    "waiverOpeningBonus": 6.0,      # bonus when the player ahead of him is hurt
    "waiverScheduleWeight": 20.0,   # per +1.00 of schedule ease (so +5% = 1 pt)
    "stashMaxAge": 24,              # keeper mode "stash" flag
    # FAAB: bid % of remaining budget = score * faabPctPerPoint, capped.
    "faabPctPerPoint": 0.9,
    "faabMaxPct": 60,
}

# ---------------------------------------------------------------------------
# 9. DATA SAFETY CHECKS  (pipeline refuses to publish if any of these fail)
# ---------------------------------------------------------------------------
MIN_PLAYERS = 200               # fewer players than this = something broke
MIN_PLAYERS_PER_POSITION = {"QB": 25, "RB": 40, "WR": 60, "TE": 25, "K": 20, "DST": 28}
MAX_WEEKS_STALE = 0             # latest stats week may be at most this many
                                # weeks behind the last fully finished week
STALE_GRACE_DAYS = 1            # a week counts as finished 1 day after its last game
MAX_PPG = 40                    # nobody projects above this per game (sanity)

# ---------------------------------------------------------------------------
# 10. SOURCES
# ---------------------------------------------------------------------------
SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"
FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K"]
