# Fantasy Trade Calculator & Waiver Helper

**Live site:** https://wpcsimmons-oss.github.io/trade-calculator/

A free fantasy football tool that runs entirely in your web browser.

## What it does

- **Settings & Roster** – tell it your league (redraft or keeper, size, scoring, lineup) and pick your players, one per roster slot.
- **Trade Calculator** – pick who you give and who you get. It rebuilds your best starting lineup for every remaining week, before and after the trade, and tells you whether you win or lose, by how many points, what happens in the fantasy playoffs (weeks 15–17), and why. It also estimates how the deal looks to the other team.
- **Waiver Wire** – ranks free agents by how much they'd help *your* team, suggests who to drop, and gives a FAAB bid range.
- **Keeper mode** – adds a next-season value for each player, the draft round that value is worth, and how much you save versus your keeper cost.

Your settings and roster are saved only in your own browser. There is no server, no account, and no passwords or API keys anywhere in this project.

## Where the numbers come from

Player values are based on **usage** (share of targets, air yards, carries, red-zone and goal-line touches, snaps), weighted toward the last 3–4 games, with lucky touchdowns and hot efficiency pulled back toward league average, then adjusted for each remaining opponent, byes and injuries.

Data sources:

- [nflverse](https://github.com/nflverse) via the `nflreadpy` package – weekly stats, play-by-play, snap counts, schedules, injuries, depth charts (licensed CC-BY 4.0: free to use with credit, which the site gives).
- [Sleeper's public API](https://docs.sleeper.com/) – player names, teams, positions, ages, injury status. It needs no login. Sleeper asks that the player list be fetched no more than about once a day; this project fetches it twice a week.

If a source is down during an update, that part is skipped and a note appears at the top of the site.

**Every weight and formula setting is in one file: [`pipeline/config.py`](pipeline/config.py).** Edit a number there, save ("commit") it, and the site rebuilds itself with the new values within a few minutes.

## How the automatic refresh works

GitHub runs a small program for you, for free, called a **workflow** (the file is `.github/workflows/refresh.yml`). Every **Tuesday and Thursday at 14:00 UTC** it:

1. downloads the latest data and recalculates every player's value,
2. runs safety checks and tests,
3. saves the new `site/data/players.json` only if something changed,
4. publishes the site.

**If the data looks wrong** (fewer than 200 players, usage shares that aren't between 0 and 1, stats older than the last finished week, and so on) the workflow stops at step 2 and publishes nothing. The site keeps showing the last good version.

## How to run a refresh by hand

1. Go to the repository's **Actions** tab: https://github.com/wpcsimmons-oss/trade-calculator/actions
2. In the left sidebar click **Refresh data and deploy site**.
3. On the right click the **Run workflow** dropdown, then the green **Run workflow** button.
4. After about two minutes the run shows a green tick. Refresh the live site.

## If the workflow fails (red ✗)

GitHub emails you when a run fails. The site is still fine – it's showing the last good data.

1. Open the **Actions** tab and click the failed run, then click the **refresh** job.
2. Open the step with the red ✗ and read the last few lines:
   - **"DATA CHECKS FAILED"** in the pipeline step – the message says which check failed. The most common is *"Stats are stale"*: the data provider hasn't posted the latest week yet. Nothing to fix; the next scheduled run (or a manual run a few hours later) will usually pass.
   - **A failure in "Run the tests"** – usually caused by an edit to `config.py` or the code. Undo the last change, or ask for help with the error text.
   - **A failure in the Pages steps** – check that **Settings → Pages → Source** is still set to **GitHub Actions**.
3. To try again, click **Re-run all jobs** at the top right of the failed run.

## If the workflow gets disabled

GitHub automatically pauses scheduled workflows in repositories with **no activity for 60 days** – this will happen each off-season, because there's no new data to save. GitHub emails you before it does.

To switch it back on: **Actions** tab → **Refresh data and deploy site** in the sidebar → click the **Enable workflow** button in the yellow banner. Then run it once by hand (see above).

Outside the season the workflow still runs harmlessly: before week 1 and after week 17 it simply reports there's nothing to update and leaves the last data in place.

## For the curious: what's in each folder

| Folder / file | What it is |
| --- | --- |
| `pipeline/config.py` | All the weights and settings, with comments |
| `pipeline/sources.py` | Downloads the data |
| `pipeline/engine.py` | Turns usage into projected points per player |
| `pipeline/validate.py` | The safety checks |
| `pipeline/build.py` | Runs the above and writes `site/data/players.json` |
| `site/` | The website (`index.html`, `style.css`, `app.js`, and `engine.js` for the in-browser maths) |
| `tests/` | Automatic tests for the value maths, lineup optimizer, eligibility and trade scoring |
| `.github/workflows/refresh.yml` | The Tuesday/Thursday schedule |

To run it on your own computer (optional; needs Python 3.11+ and Node):

```bash
pip install -r requirements.txt
python -m pipeline.build          # downloads data, writes site/data/players.json
python -m pytest -q               # pipeline tests
node --test tests/*.test.js       # page-maths tests
python -m http.server 8000 --directory site   # then open http://localhost:8000
```

*Hobby project. Not affiliated with the NFL, Sleeper or nflverse. Not betting advice.*
