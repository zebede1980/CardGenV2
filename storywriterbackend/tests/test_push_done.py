"""🔔 "It's done" notifications (plans/ios-app.md, Stage 3): who gets pushed
when, what the lock screen shows, and the proxy's report of finished jobs.

Run from storywriterbackend/:
    uv run --python 3.12 --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_autowrite import HEADERS  # noqa: F401  (sets DATABASE_URL before app imports)
from test_messenger import FakeModel, _events, _new
from test_push import Device, FakePushService, _subscribe

import pywebpush
from app.models import Base, CharacterCard, SessionLocal, Settings, User, engine
from app.routers import chat as chat_router
from app.routers import messenger
from app.routers import push as push_router
from app.services import push, story_autowriter
from app.services.llm_service import ReasoningChunk

PROXY = {**HEADERS, "X-Proxy-Job": "1"}


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    push._cached.clear()
    push._presence.clear()
    with SessionLocal() as db:
        user = User(username="cardgen_1", password="x")
        db.add(user)
        db.commit()
        db.add(Settings(user_id=user.id, api_key="k", api_base_url="https://nano-gpt.com/api/v1", model="glm",
                        temperature=0.8, top_p=0.95, context_window=8000))
        db.add(CharacterCard(user_id=user.id, name="Mira", description="Teases a lot."))
        db.commit()
    app = FastAPI()
    for r in (chat_router.router, messenger.router, push_router.router):
        app.include_router(r, prefix="/api")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def model(monkeypatch):
    m = FakeModel()
    m.install(monkeypatch)
    return m


@pytest.fixture()
def pushes(monkeypatch):
    """Records what would be delivered instead of sending it."""
    sent = []
    monkeypatch.setattr(push, "deliver", lambda user_id, kind, **m: sent.append({"user": user_id, "kind": kind, **m}) or {"ok": 1})
    return sent


def _wait(pred, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return pred()


def _presence(client, page, visible):
    assert client.post("/api/push/presence", json={"page": page, "visible": visible}, headers=HEADERS).status_code == 200


def _text(client, cid, page=None, content="hi"):
    headers = {**HEADERS, **({"X-Page-Id": page} if page else {})}
    r = client.post(f"/api/messenger/{cid}/message", json={"content": content}, headers=headers)
    assert r.status_code == 200, r.text
    return _events(r.text)


# ── Who gets pushed ─────────────────────────────────────────────────────────

def test_away_follows_the_page_and_falls_back_on_the_reader():
    push._presence.clear()
    push.set_presence(1, "page-a", False)
    push.set_presence(1, "page-b", True)
    assert push.away(1, "page-a") and not push.away(1, "page-b")
    assert not push.away(1, "page-b", reading=False)  # on screen beats a dropped socket
    assert not push.away(2, "page-a")                  # someone else's page id counts for nothing
    assert push.away(1, "never-seen", reading=False) and not push.away(1, "never-seen", reading=True)
    assert not push.away(1, None) and not push.away(1, "bad id!", reading=None)


def test_a_messenger_reply_pushes_only_while_the_page_is_hidden(client, model, pushes):
    m = _new(client)
    _presence(client, "phone", True)
    _text(client, m["id"], page="phone")
    time.sleep(0.2)
    assert pushes == []

    _presence(client, "phone", False)
    _text(client, m["id"], page="phone")
    assert _wait(lambda: len(pushes) == 1)
    p = pushes[0]
    assert (p["kind"], p["name"], p["generic"]) == ("messenger", "💌 Mira", "Sent you a message.")
    assert p["preview"] == "hey you 😊" and not p["failed"]
    assert (p["path"], p["tag"]) == (f"/?open=messenger&id={m['id']}", f"msg-{m['id']}")


def test_an_old_page_without_an_id_never_pushes(client, model, pushes):
    m = _new(client)
    _text(client, m["id"])
    time.sleep(0.2)
    assert pushes == []


def test_a_failed_reply_says_so(client, model, pushes):
    m = _new(client)
    _presence(client, "phone", False)
    model.replies = [[RuntimeError("upstream 502")]]
    _text(client, m["id"], page="phone")
    assert _wait(lambda: len(pushes) == 1)
    assert pushes[0]["failed"] and "didn't come through" in pushes[0]["generic"]


def test_a_roleplay_reply_pushes_with_the_speaker(client, model, pushes):
    chat = client.post("/api/chats/", json={"title": "RP", "card_ids": [1]}, headers=HEADERS).json()
    _presence(client, "phone", False)
    model.replies = [[ReasoningChunk("Plan."), "*Mira grins.* \"Took you long enough.\""]]
    r = client.post(f"/api/chats/{chat['id']}/message", json={"content": "hello"}, headers={**HEADERS, "X-Page-Id": "phone"})
    assert r.status_code == 200, r.text
    assert _wait(lambda: len(pushes) == 1)
    p = pushes[0]
    assert (p["kind"], p["name"], p["generic"]) == ("chat", "💬 Mira", "Mira replied.")
    assert p["preview"] == 'Mira grins. "Took you long enough."' and p["path"] == f"/?open=roleplay&id={chat['id']}"


def test_an_auto_story_pushes_unless_the_page_is_polling(client, pushes):
    with SessionLocal() as db:
        from app.models import Story
        db.add(Story(id=7, title="The Lighthouse", user_id=1))
        db.commit()
    run = story_autowriter.Run(7, 1)
    run.last_poll = time.monotonic()
    story_autowriter._notify(run, "Finished: 4 chapters. Tap to read it.")
    assert pushes == []
    run.last_poll = time.monotonic() - 60
    story_autowriter._notify(run, "Finished: 4 chapters. Tap to read it.")
    assert pushes[0]["name"] == "✨ The Lighthouse" and pushes[0]["path"] == "/?open=story&id=7"


# ── What the lock screen shows ──────────────────────────────────────────────

def test_privacy_levels():
    assert push.compose("preview", "💌 Mira", "Sent you a message.", "hey you") == ("💌 Mira", "hey you")
    assert push.compose("name", "💌 Mira", "Sent you a message.", "hey you") == ("💌 Mira", "Sent you a message.")
    assert push.compose("nothing", "💌 Mira", "Sent you a message.", "hey you") == \
        ("CardGen", "Something you were waiting for is ready.")
    assert push.compose("preview", "💌 Mira", "Reply failed.", "", failed=True) == ("💌 Mira", "Reply failed.")
    assert push.compose("nothing", "x", "y", failed=True)[1] == "Something you were waiting for didn't finish."


def test_excerpt_is_plain_and_short():
    assert push.excerpt("<think>secret plan</think>*She waves.* **Hi!**") == "She waves. Hi!"
    assert push.excerpt('look <photo id="ab12"/> nice') == "look 📷 Photo nice"
    long = push.excerpt("word " * 80)
    assert len(long) <= 141 and long.endswith("…")


def test_prefs_default_save_and_ignore_junk(client):
    assert client.get("/api/push/prefs", headers=HEADERS).json() == push.DEFAULT_PREFS
    out = client.put("/api/push/prefs", json={"kinds": {"chat": False, "bogus": True}, "privacy": "loud"}, headers=HEADERS).json()
    assert out["kinds"]["chat"] is False and "bogus" not in out["kinds"] and out["privacy"] == "name"
    out = client.put("/api/push/prefs", json={"privacy": "nothing"}, headers=HEADERS).json()
    assert out["privacy"] == "nothing" and out["kinds"]["chat"] is False


def test_deliver_respects_prefs_and_privacy(client, monkeypatch):
    service = FakePushService()
    monkeypatch.setattr(pywebpush.requests, "post", service.post)
    d = Device()
    _subscribe(client, d)
    client.put("/api/push/prefs", json={"privacy": "preview"}, headers=HEADERS)
    push.deliver(1, "messenger", name="💌 Mira", generic="Sent you a message.", preview="hey you",
                 path="/?open=messenger&id=c1", tag="msg-c1")
    note = d.read(service.sent[-1]["data"])["notification"]
    assert (note["title"], note["body"], note["tag"]) == ("💌 Mira", "hey you", "msg-c1")
    client.put("/api/push/prefs", json={"kinds": {"messenger": False}}, headers=HEADERS)
    assert push.deliver(1, "messenger", name="x", generic="y")["skipped"] == "off"
    assert len(service.sent) == 1


# ── The proxy's report of finished jobs ─────────────────────────────────────

def test_jobs_done_needs_the_proxy_header(client, pushes):
    body = {"page": "phone", "view": "cardgen", "attached": False, "items": [{"label": "Character card"}]}
    assert client.post("/api/push/internal/jobs-done", json=body, headers=HEADERS).status_code == 404
    assert client.post("/api/push/internal/jobs-done", json=body, headers=PROXY).json() == {"pushed": True}


def test_jobs_done_pushes_for_a_hidden_page_only(client, pushes):
    _presence(client, "phone", True)
    body = {"page": "phone", "view": "playground", "attached": False, "items": [{"label": "Playground image"}]}
    assert client.post("/api/push/internal/jobs-done", json=body, headers=PROXY).json() == {"pushed": False}
    _presence(client, "phone", False)
    assert client.post("/api/push/internal/jobs-done", json={**body, "attached": True}, headers=PROXY).json() == {"pushed": True}
    p = pushes[0]
    assert (p["kind"], p["name"], p["generic"]) == ("pictures", "🖼️ Playground", "Playground image is ready.")
    assert (p["path"], p["tag"]) == ("/?open=playground", "jobs-playground")


def test_jobs_done_batches_and_failures(client, pushes):
    _presence(client, "phone", False)
    items = [{"label": "Character card"}, {"label": "Character card"}, {"label": "Character image", "ok": False, "error": "Local GPU is offline"}]
    client.post("/api/push/internal/jobs-done", json={"page": "phone", "view": "cardgen", "items": items}, headers=PROXY)
    assert pushes[-1]["generic"] == "2 ready (Character card); 1 failed." and not pushes[-1]["failed"]
    client.post("/api/push/internal/jobs-done", json={"page": "phone", "view": "cardgen", "items": items[2:]}, headers=PROXY)
    assert pushes[-1]["generic"] == "Character image failed: Local GPU is offline." and pushes[-1]["failed"]
    client.post("/api/push/internal/jobs-done", json={"page": "phone", "view": "nonsense", "items": items[:1]}, headers=PROXY)
    assert pushes[-1]["path"] == "/?open=cardgen" and pushes[-1]["name"] == "🎭 Character Generator"


def test_an_adventure_beat_pushes_with_its_title(monkeypatch, pushes):
    import test_adventure as ta
    from app.routers import adventure
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    push._presence.clear()
    with SessionLocal() as db:
        user = User(username="cardgen_1", password="x")
        db.add(user)
        db.commit()
        db.add(Settings(user_id=user.id, api_key="k", api_base_url="https://nano-gpt.com/api/v1", model="glm",
                        temperature=0.8, top_p=0.95, context_window=8000))
        db.add(CharacterCard(user_id=user.id, name="Mira", description="A courier."))
        db.commit()
    ta.FakeModel().install(monkeypatch)
    app = FastAPI()
    app.include_router(adventure.router, prefix="/api")
    with TestClient(app) as c:
        sid = ta._new(c)["id"]
        push.set_presence(1, "phone", False)
        r = c.post(f"/api/adventures/{sid}/action", json={"role": "system"}, headers={**HEADERS, "X-Page-Id": "phone"})
        assert r.status_code == 200, r.text
    assert _wait(lambda: len(pushes) == 1)
    p = pushes[0]
    assert p["kind"] == "adventure" and p["name"].startswith("🎲 ") and p["generic"] == "The next part is ready."
    assert p["preview"].startswith("The lanterns swung") and p["path"] == f"/?open=adventure&id={sid}"
