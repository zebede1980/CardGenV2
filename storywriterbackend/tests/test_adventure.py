"""Adventure mode against a fake model.

Run from storywriterbackend/:
    uv run --python 3.12 --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
import asyncio
import json
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_autowrite import HEADERS  # noqa: F401  (sets DATABASE_URL before app imports)

from app.models import AdventureAction, AdventureSession, Base, CharacterCard, SessionLocal, Settings, User, engine
from app.routers import adventure
from app.routers.adventure import split_adventure_options
from app.services.llm_service import LLMService, ReasoningChunk

BEAT = ("The lanterns swung on their hooks. Mira counted them twice.\n\n"
        "\"Eleven,\" she said. \"There were twelve last night.\"")
OPTS = "\n\n[OPTION 1] A stranger interrupts\n[OPTION 2] The lantern falls\n[OPTION 3] Tobias lies\n[OPTION 4] The tide turns"


class FakeModel:
    """Replaces LLMService.generate. `beats` is a queue of scripted replies for
    beat calls: a list of chunks (str / ReasoningChunk), or an Exception to raise
    after the chunks before it."""

    def __init__(self):
        self.calls = []
        self.beats = []
        self.repair_reply = "[OPTION 1] Run\n[OPTION 2] Hide\n[OPTION 3] Fight\n[OPTION 4] Talk"
        self.gate = None  # threading.Event a beat waits on before its last chunk

    def install(self, monkeypatch):
        model = self

        async def generate(llm, messages, stream=False, **kwargs):
            last = messages[-1]["content"]
            model.calls.append({"messages": messages, "kwargs": kwargs})
            if "evocative title" in last:
                yield "\"The Eleventh Lantern\""
                return
            if last.startswith(("Your story section is above", "Offer four NEW choices")):
                yield model.repair_reply
                return
            if "summarizes narrative adventures" in messages[0]["content"]:
                yield "Summary."
                return
            script = model.beats.pop(0) if model.beats else [ReasoningChunk("Plan."), BEAT, OPTS]
            for i, part in enumerate(script):
                if isinstance(part, Exception):
                    raise part
                if model.gate is not None and i == len(script) - 1:
                    while not model.gate.is_set():
                        await asyncio.sleep(0.01)
                yield part
            llm.finish_reason = "stop"

        monkeypatch.setattr(LLMService, "generate", generate)

    def beat_prompts(self):
        return [c["messages"] for c in self.calls if "interactive fiction narrator" in c["messages"][0]["content"]]


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
        db.add(CharacterCard(user_id=user.id, name="Mira", description="{{char}} is a courier who distrusts {{user}}."))
        db.commit()
    app = FastAPI()
    app.include_router(adventure.router, prefix="/api")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def model(monkeypatch):
    m = FakeModel()
    m.install(monkeypatch)
    return m


def _events(body: str):
    return [json.loads(line[6:]) for line in body.split("\n\n") if line.startswith("data: ")]


def _new(client, **body):
    r = client.post("/api/adventures/", json={"card_ids": [1], "starting_scenario": "A dark quay.", **body}, headers=HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


def _act(client, sid, **body):
    r = client.post(f"/api/adventures/{sid}/action", json={"role": "system", **body}, headers=HEADERS)
    assert r.status_code == 200, r.text
    return _events(r.text)


def _detail(client, sid):
    return client.get(f"/api/adventures/{sid}", headers=HEADERS).json()


# ── The option parser ────────────────────────────────────────────────────────

@pytest.mark.parametrize("tail", [
    "\n\n[OPTION 1] Run\n[OPTION 2] Hide\n[OPTION 3] Fight\n[OPTION 4] Talk",
    "\n\n**[Option 1]:** Run\n**[Option 2]:** Hide\n**[Option 3]:** Fight\n**[Option 4]:** Talk",
    "\n\nOPTION 1: Run\nOPTION 2 - Hide\nOption 3. Fight\nOPTION 4: Talk",
    "\n\n**What happens next?**\n\n[OPTION 1] Run\n[OPTION 2] Hide\n[OPTION 3] Fight\n[OPTION 4] Talk\n\nChoose wisely!",
    "\n\n<options>\n1. [safe] Run\n2. [risky] Hide\n3. Fight\n4. (risky) Talk\n</options>",
])
def test_options_parse_in_the_shapes_models_write(tail):
    story, options = split_adventure_options("<think>\nDraft: [OPTION 1] Wrong one\n</think>\n" + BEAT + tail)
    assert [o["text"] for o in options] == ["Run", "Hide", "Fight", "Talk"]
    assert story.endswith("There were twelve last night.\"")  # headings and markers gone
    assert story.startswith("<think>") and "Wrong one" in story  # reasoning kept, its draft not parsed


def test_risk_tags_are_read():
    _, options = split_adventure_options(BEAT + "\n<options>\n1. [safe] Run\n2. [risky] Hide\n3. Fight\n4. (risky) Talk\n</options>")
    assert [o["risk"] for o in options] == ["safe", "risky", "", "risky"]


def test_a_recap_earlier_in_the_beat_does_not_count():
    text = "She remembered choosing [OPTION 1] last time.\n\n" + BEAT + OPTS
    story, options = split_adventure_options(text)
    assert options[0]["text"] == "A stranger interrupts" and "remembered" in story


# ── Beats ────────────────────────────────────────────────────────────────────

def test_first_beat_saves_story_and_options_and_names_the_adventure(client, model):
    adv = _new(client)
    assert adv["title_auto"] is True
    events = _act(client, adv["id"])
    final = next(e for e in events if e["type"] == "final")
    assert [o["text"] for o in final["options"]] == ["A stranger interrupts", "The lantern falls", "Tobias lies", "The tide turns"]
    assert any(e["type"] == "title" and e["title"] == "The Eleventh Lantern" for e in events)

    detail = _detail(client, adv["id"])
    assert detail["title"] == "The Eleventh Lantern" and detail["title_auto"] is False
    beat = detail["actions"][-1]
    assert beat["role"] == "assistant" and "[OPTION" not in beat["content"]
    assert json.loads(beat["options"])[0] == {"text": "A stranger interrupts", "risk": ""}

    listed = client.get("/api/adventures/", headers=HEADERS).json()[0]
    assert listed["characters"] == [{"id": 1, "name": "Mira"}]
    assert listed["beats"] == 1 and listed["excerpt"].startswith("The lanterns swung")
    assert "description" not in json.dumps(listed)  # the list no longer carries whole cards


def test_card_macros_are_filled_in(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    system = model.beat_prompts()[0][0]["content"]
    assert "Mira is a courier who distrusts the user." in system and "{{" not in system


def test_missing_options_are_asked_for_separately(client, model):
    model.beats = [[BEAT]]
    adv = _new(client)
    events = _act(client, adv["id"])
    assert any(e["type"] == "status" for e in events)
    final = next(e for e in events if e["type"] == "final")
    assert [o["text"] for o in final["options"]] == ["Run", "Hide", "Fight", "Talk"]
    assert json.loads(_detail(client, adv["id"])["actions"][-1]["options"])[3]["text"] == "Talk"


def test_a_failed_beat_is_not_stored(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    model.beats = [[RuntimeError("upstream 502")]]
    events = _act(client, adv["id"], role="user", content="A stranger interrupts")
    assert any(e["type"] == "error" and "502" in e["message"] for e in events)
    final = next(e for e in events if e["type"] == "final")
    assert final["deleted"] is True
    actions = _detail(client, adv["id"])["actions"]
    assert actions[-1]["role"] == "user"  # the choice stays; no empty or error-text beat
    assert not any("Generation error" in a["content"] for a in actions)


def test_a_placeholder_orphaned_by_a_restart_is_removed(client, model):
    adv = _new(client)
    with SessionLocal() as db:
        db.add(AdventureAction(session_id=adv["id"], order_index=0, role="assistant", content=""))
        db.commit()
    assert _detail(client, adv["id"])["actions"] == []
    _act(client, adv["id"])  # and a new beat isn't refused as "already writing"
    assert len(_detail(client, adv["id"])["actions"]) == 1


def test_order_stays_unique_after_deleting_from_the_middle(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    _act(client, adv["id"], role="user", content="Run")
    _act(client, adv["id"], role="user", content="Hide")
    actions = _detail(client, adv["id"])["actions"]
    client.delete(f"/api/adventures/{adv['id']}/actions/{actions[1]['id']}", headers=HEADERS)
    _act(client, adv["id"], role="user", content="Fight")
    idx = [a["order_index"] for a in _detail(client, adv["id"])["actions"]]
    assert len(idx) == len(set(idx)) and idx == sorted(idx)
    assert _detail(client, adv["id"])["actions"][-2]["content"] == "Fight"


def test_edit_keeps_the_reasoning_block(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    beat = _detail(client, adv["id"])["actions"][-1]
    r = client.put(f"/api/adventures/{adv['id']}/actions/{beat['id']}", json={"content": "Rewritten."}, headers=HEADERS)
    assert r.json()["content"].startswith("<think>") and r.json()["content"].endswith("Rewritten.")


def test_rename_stops_auto_titling(client, model):
    adv = _new(client)
    client.patch(f"/api/adventures/{adv['id']}", json={"title": "Salt and Smoke"}, headers=HEADERS)
    events = _act(client, adv["id"])
    assert not any(e["type"] == "title" for e in events)
    assert _detail(client, adv["id"])["title"] == "Salt and Smoke"


def test_stop_cancels_on_the_server_and_keeps_what_arrived(client, model):
    model.gate = threading.Event()
    model.beats = [[ReasoningChunk("Plan."), "The lanterns swung on their hooks. ", OPTS]]
    adv = _new(client)
    out = {}
    t = threading.Thread(target=lambda: out.update(events=_act(client, adv["id"])))
    t.start()
    deadline = time.time() + 5
    while not any(isinstance(v, asyncio.Task) for v in adventure._ACTIVE.values()):
        assert time.time() < deadline, "beat never started"
        time.sleep(0.01)
    action_id = next(k for k, v in adventure._ACTIVE.items() if isinstance(v, asyncio.Task))
    time.sleep(0.1)  # let the first chunks arrive
    # A second beat can't start while this one is live.
    assert client.post(f"/api/adventures/{adv['id']}/action", json={"role": "system"}, headers=HEADERS).status_code == 409
    res = client.post(f"/api/adventures/{adv['id']}/actions/{action_id}/cancel", headers=HEADERS).json()
    t.join(5)
    model.gate.set()
    assert res["cancelled"] is True and res["deleted"] is False
    assert "lanterns swung" in res["content"] and res["options"] == []
    assert next(e for e in out["events"] if e["type"] == "final")["action_id"] == action_id
    assert len(model.beat_prompts()) == 1  # no options follow-up after a Stop


# ── Rewind, regenerate, new options, pictures, openings ──────────────────────

def test_rewind_removes_everything_after_the_beat(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    _act(client, adv["id"], role="user", content="Run")
    _act(client, adv["id"], role="user", content="Hide")
    first = _detail(client, adv["id"])["actions"][0]
    r = client.post(f"/api/adventures/{adv['id']}/rewind/{first['id']}", headers=HEADERS)
    assert r.status_code == 200
    assert [a["id"] for a in r.json()["actions"]] == [first["id"]]


def test_regen_replaces_the_latest_beat_and_quotes_it(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    old = _detail(client, adv["id"])["actions"][-1]
    model.beats = [[ReasoningChunk("Plan."), "A different night entirely.", OPTS]]
    _act(client, adv["id"], kind="regen")
    actions = _detail(client, adv["id"])["actions"]
    assert len(actions) == 1 and actions[0]["id"] != old["id"] and "different night" in actions[0]["content"]


def test_new_options_for_the_latest_beat(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    beat = _detail(client, adv["id"])["actions"][-1]
    model.repair_reply = "[OPTION 1] Swim\n[OPTION 2] Sing\n[OPTION 3] Sleep\n[OPTION 4] Steal"
    r = client.post(f"/api/adventures/{adv['id']}/actions/{beat['id']}/options", json={}, headers=HEADERS)
    ev = next(e for e in _events(r.text) if e["type"] == "options")
    assert [o["text"] for o in ev["options"]] == ["Swim", "Sing", "Sleep", "Steal"]
    assert json.loads(_detail(client, adv["id"])["actions"][-1]["options"])[0]["text"] == "Swim"
    # Only the latest beat's choices can change.
    _act(client, adv["id"], role="user", content="Swim")
    r = client.post(f"/api/adventures/{adv['id']}/actions/{beat['id']}/options", json={}, headers=HEADERS)
    assert r.status_code == 409


def test_picture_is_stored_apart_from_the_story(client, model):
    adv = _new(client)
    _act(client, adv["id"])
    beat = _detail(client, adv["id"])["actions"][-1]
    url = f"/api/adventures/{adv['id']}/actions/{beat['id']}/image"
    assert client.put(url, json={"image": "javascript:alert(1)"}, headers=HEADERS).status_code == 400
    assert client.put(url, json={"image": "data:image/png;base64,AAAA", "prompt": "a quay"}, headers=HEADERS).status_code == 200
    detail = _detail(client, adv["id"])
    assert detail["actions"][-1]["has_image"] is True and "AAAA" not in json.dumps(detail)
    assert client.get(url, headers=HEADERS).json() == {"image": "data:image/png;base64,AAAA", "prompt": "a quay"}


def test_inspire_returns_three_openings(client, model, monkeypatch):
    async def generate(llm, messages, stream=False, **kwargs):
        yield "1. A lighthouse door appears in the rock overnight.\n2. The circus arrives one wagon short.\n3. A letter postmarked forty years ago arrives."
    monkeypatch.setattr(LLMService, "generate", generate)
    r = client.post("/api/adventures/inspire", json={"card_ids": [1]}, headers=HEADERS)
    ev = next(e for e in _events(r.text) if e["type"] == "openings")
    assert len(ev["openings"]) == 3 and ev["openings"][1].startswith("The circus")
