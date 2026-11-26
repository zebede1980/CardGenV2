"""🎭 Personas: persona cards, following them from chats and adventures, and
moving the old saved_user_personas rows into persona cards.

Run from storywriterbackend/:
    uv run --python 3.12 --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
import json
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_autowrite import HEADERS  # noqa: F401  (sets DATABASE_URL before app imports)

from app.models import (AdventureSession, AppSecret, Base, CharacterCard, ChatCharacterLink, RoleplayChat,
                        SavedUserPersona, SessionLocal, User, engine)
from app.routers import adventure, cards, chat as chat_router, messenger, personas
from app.services import persona as persona_svc

OTHER = {"X-User-Id": "2", "X-Internal-Secret": "test-secret"}


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        db.add_all([User(username="cardgen_1", password="x"), User(username="cardgen_2", password="x")])
        db.commit()
    app = FastAPI()
    for r in (cards.router, personas.router, chat_router.router, messenger.router, adventure.router):
        app.include_router(r, prefix="/api")
    with TestClient(app) as c:
        yield c


def _persona(client, name="Joe", **meta):
    body = {"name": name, "description": f"# {name}\n\n{name} is a tall courier with a scar.",
            "personality": "Dry, patient.", "kind": "persona",
            "persona": json.dumps({"age": "34", "gender": "he/him", "voice": "Short sentences.", **meta})}
    r = client.post("/api/cards/", json=body, headers=HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


def _character(client, name="Mira", **fields):
    r = client.post("/api/cards/", json={"name": name, "description": "{{char}} distrusts {{user}}.", **fields},
                    headers=HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


# ── Cards ─────────────────────────────────────────────────────────────────────

def test_kind_defaults_and_survives_an_update_that_leaves_it_out(client):
    mira = _character(client)
    assert mira["kind"] == "character" and mira["persona"] == ""
    joe = _persona(client)
    assert joe["kind"] == "persona"
    assert json.loads(joe["persona"]) == {"age": "34", "gender": "he/him", "voice": "Short sentences.",
                                          "isDefault": False}

    # An older client's save (no kind, no persona) keeps both.
    r = client.put(f"/api/cards/{joe['id']}", json={"name": "Joe", "description": "Edited."}, headers=HEADERS)
    assert r.status_code == 200, r.text
    assert r.json()["kind"] == "persona" and json.loads(r.json()["persona"])["age"] == "34"

    # A save can change age etc. but not isDefault, which only /default-persona sets.
    client.post(f"/api/cards/{joe['id']}/default-persona", headers=HEADERS)
    r = client.put(f"/api/cards/{joe['id']}", json={"name": "Joe", "kind": "persona",
                                                     "persona": json.dumps({"age": "35", "isDefault": False})},
                   headers=HEADERS)
    assert json.loads(r.json()["persona"]) == {"age": "35", "gender": "", "voice": "", "isDefault": True}

    # Unknown kinds become characters, and a character keeps no persona extras.
    r = client.put(f"/api/cards/{joe['id']}", json={"name": "Joe", "kind": "wizard"}, headers=HEADERS)
    assert r.json()["kind"] == "character" and r.json()["persona"] == ""


def test_summary_marks_personas_and_one_default(client):
    mira = _character(client)
    joe, ann = _persona(client), _persona(client, "Ann", gender="she/her")
    rows = {r["id"]: r for r in client.get("/api/cards/summary", headers=HEADERS).json()}
    assert rows[mira["id"]]["kind"] == "character" and "persona" not in rows[mira["id"]]
    assert rows[joe["id"]]["persona"] == {"age": "34", "gender": "he/him", "isDefault": False}

    assert client.post(f"/api/cards/{joe['id']}/default-persona", headers=HEADERS).status_code == 200
    assert client.post(f"/api/cards/{ann['id']}/default-persona", headers=HEADERS).status_code == 200
    rows = {r["id"]: r for r in client.get("/api/cards/summary", headers=HEADERS).json()}
    assert rows[ann["id"]]["persona"]["isDefault"] is True
    assert rows[joe["id"]]["persona"]["isDefault"] is False  # one default per account
    assert client.post(f"/api/cards/{mira['id']}/default-persona", headers=HEADERS).status_code == 404
    assert client.post(f"/api/cards/{ann['id']}/default-persona", headers=OTHER).status_code == 404
    client.delete("/api/cards/default-persona", headers=HEADERS)
    rows = {r["id"]: r for r in client.get("/api/cards/summary", headers=HEADERS).json()}
    assert not any(r.get("persona", {}).get("isDefault") for r in rows.values())


def test_persona_uses_count_chats_played_as_you(client):
    mira, joe = _character(client), _persona(client)
    r = client.post("/api/chats/", json={"title": "t", "card_ids": [mira["id"]], "user_persona_card_id": joe["id"]},
                    headers=HEADERS)
    assert r.status_code == 200, r.text
    rows = {r["id"]: r for r in client.get("/api/cards/summary", headers=HEADERS).json()}
    assert rows[joe["id"]]["uses"] == 1 and rows[joe["id"]]["last_used_at"]
    assert rows[mira["id"]]["uses"] == 1


# ── Following the card ────────────────────────────────────────────────────────

def test_detail_text_names_the_persona_and_drops_the_title():
    card = CharacterCard(name="Joe", kind="persona", description="# Joe\n\n{{user}} is tall. {{char}} smiles.",
                         personality="Calm.", persona=json.dumps({"voice": "Few words."}))
    assert persona_svc.detail_text(card) == "Joe is tall. Joe smiles.\n\nCalm.\n\nHow Joe talks: Few words."
    # A character card used as a persona: {{char}} is itself, and it has no voice line.
    npc = CharacterCard(name="Mira", kind="character", description="{{char}} is a courier.", persona="")
    assert persona_svc.detail_text(npc) == "Mira is a courier."


def test_roleplay_chat_follows_its_persona_card(client):
    mira, joe = _character(client), _persona(client)
    r = client.post("/api/chats/", json={"title": "t", "card_ids": [mira["id"]], "user_persona_name": "Old name",
                                         "user_persona_card_id": joe["id"]}, headers=HEADERS)
    chat = r.json()
    assert chat["user_persona_name"] == "Joe"  # the card wins over what the page sent
    assert chat["user_persona_age"] == "34" and "tall courier" in chat["user_persona_detail"]

    client.put(f"/api/cards/{joe['id']}", json={"name": "Joseph", "description": "Now a pilot.", "kind": "persona"},
               headers=HEADERS)
    again = client.get(f"/api/chats/{chat['id']}", headers=HEADERS).json()
    assert again["user_persona_name"] == "Joseph" and again["user_persona_detail"].startswith("Now a pilot.")

    # The prompt has the persona, and the card's {{user}} is the persona's name.
    with SessionLocal() as db:
        row = db.get(RoleplayChat, chat["id"])
        system = chat_router.build_chat_prompt(row, db, enable_cot=False)[0]["content"]
    assert "Name: Joseph" in system and "Now a pilot." in system
    assert "Mira distrusts Joseph." in system and "{{user}}" not in system and "{{char}}" not in system

    # Deleting the card leaves the chat with the last copy.
    client.delete(f"/api/cards/{joe['id']}", headers=HEADERS)
    gone = client.get(f"/api/chats/{chat['id']}", headers=HEADERS).json()
    assert gone["user_persona_name"] == "Joseph" and gone["user_persona_card_id"] is None


def test_switching_persona_mid_chat(client):
    mira, joe, ann = _character(client), _persona(client), _persona(client, "Ann", age="29")
    chat = client.post("/api/chats/", json={"title": "t", "card_ids": [mira["id"]], "user_persona_card_id": joe["id"]},
                       headers=HEADERS).json()
    r = client.patch(f"/api/chats/{chat['id']}", json={"user_persona_card_id": ann["id"]}, headers=HEADERS)
    assert r.status_code == 200, r.text
    assert r.json()["user_persona_name"] == "Ann" and r.json()["user_persona_age"] == "29"
    # "Just a name": no card, the typed name.
    r = client.patch(f"/api/chats/{chat['id']}", json={"user_persona_card_id": None, "user_persona_name": "Sam",
                                                       "user_persona_age": "", "user_persona_gender": "",
                                                       "user_persona_detail": ""}, headers=HEADERS)
    assert r.json()["user_persona_name"] == "Sam" and r.json()["user_persona_card_id"] is None
    # A PATCH that doesn't mention the persona leaves it alone.
    r = client.patch(f"/api/chats/{chat['id']}", json={"title": "Renamed"}, headers=HEADERS)
    assert r.json()["user_persona_name"] == "Sam"


def test_another_users_persona_card_is_ignored(client):
    mira = _character(client)
    r = client.post("/api/cards/", json={"name": "Theirs", "kind": "persona"}, headers=OTHER)
    chat = client.post("/api/chats/", json={"title": "t", "card_ids": [mira["id"]], "user_persona_name": "Me",
                                            "user_persona_card_id": r.json()["id"]}, headers=HEADERS).json()
    assert chat["user_persona_name"] == "Me"


def test_messenger_follows_and_switches(client):
    mira, joe, ann = _character(client), _persona(client), _persona(client, "Ann")
    r = client.post("/api/messenger/", json={"card_ids": [mira["id"]], "user_persona_card_id": joe["id"]},
                    headers=HEADERS)
    assert r.status_code == 200, r.text
    chat = r.json()
    assert chat["user_persona_name"] == "Joe"
    r = client.patch(f"/api/messenger/{chat['id']}", json={"user_persona_card_id": ann["id"]}, headers=HEADERS)
    assert r.json()["user_persona_name"] == "Ann"
    client.put(f"/api/cards/{ann['id']}", json={"name": "Annie", "kind": "persona"}, headers=HEADERS)
    with SessionLocal() as db:
        user = db.get(User, 1)
        row = messenger._get_chat(db, chat["id"], user)
        assert row.user_persona_name == "Annie"


def test_adventure_protagonist_follows_its_card(client):
    mira, joe = _character(client), _persona(client)
    r = client.post("/api/adventures/", json={"card_ids": [mira["id"]], "config": {
        "mode": "protagonist", "persona": {"name": "typed", "detail": "", "cardId": joe["id"]}}}, headers=HEADERS)
    assert r.status_code == 200, r.text
    adv_id = r.json()["id"]
    with SessionLocal() as db:
        cfg = db.get(AdventureSession, adv_id).config
    assert cfg["persona"]["name"] == "Joe" and "tall courier" in cfg["persona"]["detail"]
    client.put(f"/api/cards/{joe['id']}", json={"name": "Jo", "description": "A diver.", "kind": "persona"},
               headers=HEADERS)
    with SessionLocal() as db:
        session_data = db.get(AdventureSession, adv_id)
        system = adventure.build_adventure_prompt(session_data, db)[0]["content"]
    assert "The protagonist (played by the reader): Jo\nA diver." in system


# ── The old saved personas ────────────────────────────────────────────────────

def _old_rows():
    with SessionLocal() as db:
        db.add_all([
            SavedUserPersona(user_id=1, name="Joe", age="34", gender="male", detail="Tall."),
            SavedUserPersona(user_id=1, name="Joe", age="34", gender="male", detail="Tall."),  # exact duplicate
            SavedUserPersona(user_id=1, name="Ann", age="", gender="", detail=""),
            SavedUserPersona(user_id=2, name="Joe", age="", gender="", detail="Theirs."),
        ])
        db.add(RoleplayChat(id="c1", user_id=1, title="t", user_persona_name="Joe", user_persona_age="34",
                            user_persona_gender="male", user_persona_detail="Tall."))
        db.add(RoleplayChat(id="c2", user_id=1, title="t", user_persona_name="Stranger"))
        db.add(AdventureSession(id="a1", user_id="1", title="a", play_config=json.dumps(
            {"mode": "protagonist", "persona": {"name": "Ann", "detail": ""}})))
        db.commit()


def test_migration_moves_rows_once_and_links_matching_chats(client):
    _old_rows()
    with SessionLocal() as db:
        assert persona_svc.migrate_saved_personas(db) == 3
        assert persona_svc.migrate_saved_personas(db) == 0  # the marker stops a second run
        assert db.get(AppSecret, persona_svc.MIGRATION_MARKER) is not None
        mine = db.query(CharacterCard).filter(CharacterCard.user_id == 1, CharacterCard.kind == "persona").all()
        assert sorted(c.name for c in mine) == ["Ann", "Joe"]
        joe = next(c for c in mine if c.name == "Joe")
        assert persona_svc.meta(joe)["gender"] == "male" and joe.description == "Tall."
        assert db.get(RoleplayChat, "c1").user_persona_card_id == joe.id
        assert db.get(RoleplayChat, "c2").user_persona_card_id is None
        ann = next(c for c in mine if c.name == "Ann")
        assert db.get(AdventureSession, "a1").config["persona"]["cardId"] == ann.id

    # The old route now reads persona cards.
    listed = client.get("/api/personas", headers=HEADERS).json()
    assert sorted(p["name"] for p in listed) == ["Ann", "Joe"]
    assert [p["name"] for p in client.get("/api/personas", headers=OTHER).json()] == ["Joe"]


def test_old_persona_route_writes_persona_cards(client):
    r = client.post("/api/personas", json={"name": "Kim", "age": "40", "gender": "", "detail": "Quiet."},
                    headers=HEADERS)
    assert r.status_code == 200, r.text
    again = client.post("/api/personas", json={"name": "Kim", "age": "40", "gender": "", "detail": "Quiet."},
                        headers=HEADERS)
    assert again.json()["id"] == r.json()["id"]  # same persona, not a second card
    card = client.get(f"/api/cards/{r.json()['id']}", headers=HEADERS).json()
    assert card["kind"] == "persona" and card["description"] == "Quiet."
    assert client.delete(f"/api/personas/{card['id']}", headers=HEADERS).status_code == 200
    assert client.get(f"/api/cards/{card['id']}", headers=HEADERS).status_code == 404
