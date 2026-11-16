"""Checks the real site/data/players.json that is about to be published."""
import json
from pathlib import Path

from pipeline import validate

FILE = Path(__file__).resolve().parent.parent / "site" / "data" / "players.json"


def test_published_file_passes_every_safety_check():
    data = json.loads(FILE.read_text())
    assert validate.check_output(data["players"], data["meta"]) == []
    assert {"week", "generated", "weeks", "config", "sources"} <= set(data["meta"])
    # nothing private should ever be in the published file
    text = FILE.read_text().lower()
    for word in ("token", "password", "secret", "api_key"):
        assert word not in text
