"""💌 Messenger against a fake model.

Run from storywriterbackend/:
    uv run --python 3.12 --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
import asyncio
import json
import threading
import time
from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_autowrite import HEADERS  # noqa: F401  (sets DATABASE_URL before app imports)

from app.models import Base, CharacterCard, ChatMessage, RoleplayChat, SessionLocal, Settings, User, engine
from app.routers import chat as chat_router
from app.routers import messenger
from app.services import messenger_prompt as mp
from app.services.llm_service import LLMService, ReasoningChunk


class FakeModel:
    def __init__(self):
        self.calls = []
        self.replies = []   # queued reply scripts: list of chunks (str/ReasoningChunk) or an Exception
        self.gate = None

    def install(self, monkeypatch):
        model = self

        async def generate(llm, messages, stream=False, **kwargs):
            model.calls.append({"messages": messages, "kwargs": kwargs})
            first = messages[0]["content"]
            if "concise list of facts" in first:
                yield "- Joe has a dog called Biscuit\n- Joe starts a new job on Monday"
                return
            if "summarizes" in first.lower() or "summary" in first.lower()[:80]:
                yield "Summary."
                return
            if "write" in messages[-1]["content"] and "next message instead" in messages[-1]["content"]:
                yield "on my way!!"
                return
            script = model.replies.pop(0) if model.replies else [ReasoningChunk("Think."), "hey you 😊\n\nhow was the interview??"]
            for i, part in enumerate(script):
                if isinstance(part, Exception):
                    raise part
                if model.gate is not None and i == len(script) - 1:
                    while not model.gate.is_set():
                        await asyncio.sleep(0.01)
                yield part
            llm.finish_reason = "stop"

        monkeypatch.setattr(LLMService, "generate", generate)

    def reply_prompts(self):
        return [c["messages"] for c in self.calls if "Only dialogue" in c["messages"][0]["content"]]


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        user = User(username="cardgen_1", password="x")
        db.add(user)
        db.commit()
        db.add(Settings(user_id=user.id, api_key="k", api_base_url="https://nano-gpt.com/api/v1", model="glm",
                        temperature=0.8, top_p=0.95, context_window=8000))
        db.add(CharacterCard(user_id=user.id, name="Mira", description="{{char}} teases {{user}} a lot.",
                             scenario="{{char}} and {{user}} meet in a tavern.", mes_example="<START>\n{{char}}: lol ok"))
        db.add(CharacterCard(user_id=user.id, name="Annabel", description="Shy."))
        db.add(CharacterCard(user_id=user.id, name="Ann", description="Loud."))
        db.commit()
    app = FastAPI()
    app.include_router(chat_router.router, prefix="/api")
    app.include_router(messenger.router, prefix="/api")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def model(monkeypatch):
    m = FakeModel()
    m.install(monkeypatch)
    return m


def _events(body):
    return [json.loads(l[6:]) for l in body.split("\n\n") if l.startswith("data: ")]


def _new(client, cards=(1,), **settings):
    r = client.post("/api/messenger/", json={"card_ids": list(cards), "settings": settings, "user_persona_name": "Joe"}, headers=HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


def _send(client, cid, content="", **body):
    r = client.post(f"/api/messenger/{cid}/message", json={"content": content, **body}, headers=HEADERS)
    return r, (_events(r.text) if r.status_code == 200 else [])


def _detail(client, cid):
    return client.get(f"/api/chats/{cid}", headers=HEADERS).json()


def test_lobbies_are_separate(client, model):
    m = _new(client)
    rp = client.post("/api/chats/", json={"title": "RP", "card_ids": [1]}, headers=HEADERS).json()
    assert [c["id"] for c in client.get("/api/messenger/", headers=HEADERS).json()] == [m["id"]]
    assert [c["id"] for c in client.get("/api/chats/", headers=HEADERS).json()] == [rp["id"]]
    assert m["mode"] == "messenger" and rp["mode"] == "roleplay"


def test_a_reply_is_saved_as_one_burst(client, model):
    m = _new(client)
    _, ev = _send(client, m["id"], "hi! it went ok I think")
    final = next(e for e in ev if e["type"] == "final")
    assert final["content"] == "hey you 😊\n\nhow was the interview??"
    msgs = _detail(client, m["id"])["messages"]
    assert [x["role"] for x in msgs] == ["user", "assistant"] and msgs[1]["character_name"] == "Mira"
    listed = client.get("/api/messenger/", headers=HEADERS).json()[0]
    assert listed["last"].startswith("hey you") and listed["unread"] is True
    client.post(f"/api/messenger/{m['id']}/read", headers=HEADERS)
    assert client.get("/api/messenger/", headers=HEADERS).json()[0]["unread"] is False


def test_actions_names_and_tapbacks_are_cleaned_out(client, model):
    model.replies = [["<react>😂</react>Mira: *rolls her eyes*\n\nMira: you're ridiculous\n\n_sighs_\n\nanyway 💅"]]
    m = _new(client)
    _, ev = _send(client, m["id"], "I ate the whole cake")
    final = next(e for e in ev if e["type"] == "final")
    assert final["content"] == "you're ridiculous\n\nanyway 💅" and final["reaction"] == "😂"
    msgs = _detail(client, m["id"])["messages"]
    assert msgs[0]["reaction"] == "😂"  # their tapback sits on your message


def test_prompt_is_dialogue_only_with_persona_relationship_and_time(client, model):
    m = _new(client, relationship="crush")
    with SessionLocal() as db:
        db.add(ChatMessage(chat_id=m["id"], role="user", content="morning", created_at=datetime.utcnow() - timedelta(days=3)))
        db.add(ChatMessage(chat_id=m["id"], role="assistant", content="hiii", created_at=datetime.utcnow() - timedelta(days=3)))
        db.commit()
    _send(client, m["id"], "sorry I vanished", client_time="Sunday 8 November 2026, 22:15")
    system = model.reply_prompts()[-1][0]["content"]
    assert "No narration, no stage directions, no *actions*" in system
    assert "Mira teases Joe a lot." in system and "{{" not in system
    assert "Mira has a crush on Joe" in system
    assert "Sunday 8 November 2026, 22:15" in system and "3 days ago" in system
    assert "Background (the card may be written for roleplay" in system
    assert "think briefly and privately" in system  # nano-gpt reasons natively
    assert model.calls[-1]["kwargs"]["reasoning_effort"] == "medium"


def test_examples_fade_after_eight_replies(client, model):
    m = _new(client)
    with SessionLocal() as db:
        for i in range(8):
            db.add(ChatMessage(chat_id=m["id"], role="user", content=f"u{i}", created_at=datetime.utcnow() - timedelta(minutes=60 - i * 2)))
            db.add(ChatMessage(chat_id=m["id"], role="assistant", content=f"a{i}", created_at=datetime.utcnow() - timedelta(minutes=59 - i * 2)))
        db.commit()
    _send(client, m["id"], "hey")
    assert "Examples of their voice" not in model.reply_prompts()[-1][0]["content"]


def test_group_names_are_matched_exactly():
    lines = mp.split_lines("Annabel: hi\nAnn: HEY\nand another thing\nBob: who\nAnnabel:ok", ["Annabel", "Ann"])
    assert lines == [("Annabel", "hi"), ("Ann", "HEY\nand another thing\nBob: who"), ("Annabel", "ok")]


def test_group_chat_room_prompt_and_reply(client, model):
    model.replies = [["Ann: JOE!!\nAnnabel: hi joe"]]
    m = _new(client, cards=(2, 3), style="chatroom")
    _, ev = _send(client, m["id"], "hi all")
    final = next(e for e in ev if e["type"] == "final")
    assert final["content"] == "Ann: JOE!!\nAnnabel: hi joe"  # group lines keep their names
    post = model.reply_prompts()[-1][-1]["content"]
    assert "Start every line with one of these names" in post and "Annabel" in post


def test_opener_only_on_an_empty_chat(client, model):
    m = _new(client)
    r, ev = _send(client, m["id"], kind="opener")
    assert r.status_code == 200 and next(e for e in ev if e["type"] == "final")["content"]
    assert "you start the conversation" in model.reply_prompts()[-1][-1]["content"]
    r, _ = _send(client, m["id"], kind="opener")
    assert r.status_code == 409


def test_checkin_only_when_due(client, model):
    m = _new(client, checkin=True, checkin_hours=8)
    _send(client, m["id"], "night!")
    assert client.get(f"/api/messenger/{m['id']}/checkin-due", headers=HEADERS).json()["due"] is False
    assert _send(client, m["id"], kind="checkin")[0].status_code == 409
    with SessionLocal() as db:
        for x in db.query(ChatMessage).filter(ChatMessage.chat_id == m["id"]).all():
            x.created_at = datetime.utcnow() - timedelta(hours=9)
        db.commit()
    assert client.get(f"/api/messenger/{m['id']}/checkin-due", headers=HEADERS).json()["due"] is True
    r, ev = _send(client, m["id"], kind="checkin")
    assert r.status_code == 200 and "has been quiet for 9 hours" in model.reply_prompts()[-1][-1]["content"]
    assert client.get(f"/api/messenger/{m['id']}/checkin-due", headers=HEADERS).json()["due"] is False


def test_regen_replaces_the_latest_reply(client, model):
    m = _new(client)
    _send(client, m["id"], "hi")
    model.replies = [["totally different"]]
    _, ev = _send(client, m["id"], kind="regen")
    msgs = _detail(client, m["id"])["messages"]
    assert [x["content"] for x in msgs] == ["hi", "totally different"]
    assert "[Regeneration]" in model.reply_prompts()[-1][-1]["content"]


def test_a_failed_reply_is_not_stored(client, model):
    m = _new(client)
    model.replies = [[RuntimeError("upstream 502")]]
    _, ev = _send(client, m["id"], "hi")
    assert any(e["type"] == "error" for e in ev) and next(e for e in ev if e["type"] == "final")["deleted"]
    assert [x["role"] for x in _detail(client, m["id"])["messages"]] == ["user"]


def test_tapback_on_their_message_reaches_history(client, model):
    m = _new(client)
    _send(client, m["id"], "hi")
    reply = _detail(client, m["id"])["messages"][-1]
    assert client.post(f"/api/messenger/{m['id']}/messages/{reply['id']}/react", json={"emoji": "🍕"}, headers=HEADERS).status_code == 400
    client.post(f"/api/messenger/{m['id']}/messages/{reply['id']}/react", json={"emoji": "❤️"}, headers=HEADERS)
    _send(client, m["id"], "also")
    assert any(x["content"] == "[Joe reacted ❤️ to that]" for x in model.reply_prompts()[-1])


def test_stop_uses_roleplay_chats_cancel_route(client, model):
    model.gate = threading.Event()
    model.replies = [["first text\n\n", "second text"]]
    m = _new(client)
    out = {}
    t = threading.Thread(target=lambda: out.update(r=_send(client, m["id"], "hi")))
    t.start()
    deadline = time.time() + 5
    while not chat_router._ACTIVE_GENERATIONS and time.time() < deadline:
        time.sleep(0.01)
    rid = next(iter(chat_router._ACTIVE_GENERATIONS))
    time.sleep(0.1)
    assert _send(client, m["id"], "again")[0].status_code == 409
    res = client.post(f"/api/chats/{m['id']}/messages/{rid}/cancel", headers=HEADERS).json()
    t.join(5)
    model.gate.set()
    assert res["cancelled"] and res["content"] == "first text"


def test_memory_is_about_you_and_the_relationship(client, model):
    m = _new(client)
    for i in range(4):
        _send(client, m["id"], f"message {i}")
    deadline = time.time() + 5
    while time.time() < deadline and not _detail(client, m["id"])["memories"]:
        time.sleep(0.05)
    facts = [x["fact"] for x in _detail(client, m["id"])["memories"] if x["is_active"]]
    assert "Joe has a dog called Biscuit" in facts
    mem_call = next(c for c in model.calls if "concise list of facts" in c["messages"][0]["content"])
    assert "about Joe: their life, work" in mem_call["messages"][1]["content"]


def test_impersonate_writes_your_next_text(client, model):
    m = _new(client)
    _send(client, m["id"], "hi")
    r = client.post(f"/api/messenger/{m['id']}/impersonate", json={"draft": "omw"}, headers=HEADERS)
    assert next(e for e in _events(r.text) if e["type"] == "draft")["content"] == "on my way!!"
    assert len(_detail(client, m["id"])["messages"]) == 2  # nothing saved
