"""Home's character browser: the light card list, the description search, and
the tags-only update the auto-tagger uses.

Run from storywriterbackend/:
    uv run --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_autowrite import HEADERS  # noqa: F401  (sets DATABASE_URL before app imports)

from app.models import (AdventureCharacterLink, AdventureSession, Base, CharacterCard, ChatCharacterLink,
                        RoleplayChat, SessionLocal, Story, StoryCard, User, engine)
from app.routers import cards

OTHER = {"X-User-Id": "2", "X-Internal-Secret": "test-secret"}


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    app = FastAPI()
    app.include_router(cards.router, prefix="/api")
    with TestClient(app) as c:
        yield c


def _setup():
    """Three cards for user 1 (one used three times), one card for user 2."""
    old = datetime(2026, 1, 1, 12, 0, 0)
    with SessionLocal() as db:
        u1, u2 = User(username="cardgen_1", password="x"), User(username="cardgen_2", password="x")
        db.add_all([u1, u2])
        db.commit()
        mira = CharacterCard(user_id=u1.id, name="Mira", tags="female, fantasy",
                             description="# Mira's Profile\n\n**Mira** is a blonde courier who distrusts {{user}}.",
                             personality="Wary.", character_book='{"entries": [{"key": "x"}]}',
                             created_at=old, updated_at=old)
        jory = CharacterCard(user_id=u1.id, name="Jory", description="A fisherman with a dark past.",
                             created_at=old + timedelta(days=1), updated_at=old + timedelta(days=1))
        ann = CharacterCard(user_id=u1.id, name="Ann", description="", scenario="A lighthouse in a storm.",
                            created_at=old + timedelta(days=2), updated_at=old + timedelta(days=2))
        theirs = CharacterCard(user_id=u2.id, name="Mira", description="Someone else's blonde courier.")
        db.add_all([mira, jory, ann, theirs])
        db.commit()
        chat_at, story_at, adv_at = old + timedelta(days=5), old + timedelta(days=9), old + timedelta(days=7)
        db.add(RoleplayChat(id="c1", user_id=u1.id, title="t", updated_at=chat_at))
        db.add(Story(id=1, user_id=u1.id, title="s", updated_at=story_at))
        db.add(AdventureSession(id="a1", user_id=u1.id, title="a", updated_at=adv_at))
        db.commit()
        db.add_all([ChatCharacterLink(chat_id="c1", card_id=mira.id), StoryCard(story_id=1, card_id=mira.id),
                    AdventureCharacterLink(adventure_id="a1", card_id=mira.id)])
        db.commit()
        return {"mira": mira.id, "jory": jory.id, "ann": ann.id, "theirs": theirs.id, "story_at": story_at}


def test_summary_is_light_and_counts_uses(client):
    ids = _setup()
    r = client.get("/api/cards/summary", headers=HEADERS)
    assert r.status_code == 200, r.text
    rows = {row["id"]: row for row in r.json()}
    assert set(rows) == {ids["mira"], ids["jory"], ids["ann"]}  # not user 2's card
    mira = rows[ids["mira"]]
    assert mira["tags"] == ["female", "fantasy"]
    assert mira["uses"] == 3
    assert mira["last_used_at"] == ids["story_at"].isoformat()  # the latest of the three
    assert mira["has_lorebook"] is True
    assert mira["blurb"] == "Mira is a blonde courier who distrusts you.", mira["blurb"]  # no heading, no markdown
    assert "description" not in mira and "character_book" not in mira
    assert rows[ids["jory"]]["uses"] == 0 and rows[ids["jory"]]["last_used_at"] is None
    assert rows[ids["jory"]]["has_lorebook"] is False and rows[ids["jory"]]["tags"] == []


def test_search_matches_every_word_in_any_text_field(client):
    ids = _setup()
    search = lambda q: sorted(client.get("/api/cards/search", params={"q": q}, headers=HEADERS).json())  # noqa: E731
    assert search("blonde") == [ids["mira"]]               # description, and only this user's
    assert search("LIGHTHOUSE storm") == [ids["ann"]]      # scenario, case-insensitive, both words
    assert search("dark fisherman") == [ids["jory"]]
    assert search("blonde fisherman") == []                # every word must match
    assert search("fantasy") == [ids["mira"]]              # tags count
    assert search("") == []
    assert search("100%") == []                            # LIKE wildcards are literal


def test_tags_update_leaves_updated_at_alone(client):
    ids = _setup()
    before = {row["id"]: row for row in client.get("/api/cards/summary", headers=HEADERS).json()}
    r = client.patch(f"/api/cards/{ids['jory']}/tags", json={"tags": ["male", "modern", " fisherman "]}, headers=HEADERS)
    assert r.status_code == 200, r.text
    after = {row["id"]: row for row in client.get("/api/cards/summary", headers=HEADERS).json()}
    assert after[ids["jory"]]["tags"] == ["male", "modern", "fisherman"]
    assert after[ids["jory"]]["updated_at"] == before[ids["jory"]]["updated_at"]
    # Someone else's card, a missing card, and a bad body are refused.
    assert client.patch(f"/api/cards/{ids['theirs']}/tags", json={"tags": "x"}, headers=HEADERS).status_code == 404
    assert client.patch("/api/cards/99999/tags", json={"tags": "x"}, headers=HEADERS).status_code == 404
    assert client.patch(f"/api/cards/{ids['jory']}/tags", json={"tags": 5}, headers=HEADERS).status_code == 400
    with SessionLocal() as db:
        assert db.get(CharacterCard, ids["theirs"]).tags in ("", None)


def test_routes_do_not_shadow_card_ids(client):
    ids = _setup()
    assert client.get(f"/api/cards/{ids['mira']}", headers=HEADERS).json()["name"] == "Mira"
    assert client.get("/api/cards/summary", headers=OTHER).json()[0]["name"] == "Mira"
