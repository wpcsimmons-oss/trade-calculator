"""
Run with:   python -m pipeline.build

Downloads data, computes values, checks them, and writes site/data/players.json.
Exit code 0 = fine (file written, or nothing to do).
Exit code 1 = data looked wrong; NOTHING was written (last good file stays).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from . import config as C
from . import engine, sources, validate

OUT = Path(__file__).resolve().parent.parent / "site" / "data" / "players.json"


def main() -> int:
    data = sources.load_all()
    print(f"Season {data['season']}: {len(data['weekly'])} weekly rows, {len(data['games'])} games")

    if not data["weekly"]:
        print("No games have been played yet this season - nothing to update.")
        return 0 if OUT.exists() else 1

    errors = validate.check_raw(data) + validate.check_freshness(data)
    if not errors:
        players, meta = engine.build_players(data)
        if not meta["weeks"]:
            print(f"The fantasy season (through week {C.FANTASY_LAST_WEEK}) is over - keeping the last update.")
            return 0 if OUT.exists() else 1
        errors = validate.check_output(players, meta)

    if errors:
        print("\nDATA CHECKS FAILED - players.json was NOT updated:\n")
        for e in errors:
            print("  x " + e)
        return 1

    new = {"meta": meta, "players": players}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text())
            same_meta = {k: v for k, v in old["meta"].items() if k != "generated"} == \
                        {k: v for k, v in json.loads(json.dumps(meta)).items() if k != "generated"}
            if same_meta and old["players"] == json.loads(json.dumps(players)):
                print("Values are identical to the last update - file left untouched.")
                return 0
        except (ValueError, KeyError):
            pass

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(new, separators=(",", ":")))
    tmp.replace(OUT)
    valued = sum(1 for p in players if p["ppg"][0] > 0)
    print(f"Wrote {OUT} - {len(players)} players ({valued} with a value), data through week {meta['week']}.")
    for n in meta["notes"]:
        print("  note: " + n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
