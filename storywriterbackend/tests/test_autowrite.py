"""Auto-written stories and the output-token ceiling, against a fake model.

Run from storywriterbackend/:
    uv run --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
import asyncio
import json
import os
import tempfile
import time

_DB = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_DB}"
os.environ["INTERNAL_API_SECRET"] = "test-secret"

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.models import Base, CharacterCard, SessionLocal, Settings, Story, StorySegment, User, engine  # noqa: E402
from app.routers import autowrite, generation, stories  # noqa: E402
from app.services import llm_service, story_autowriter as aw  # noqa: E402
from app.services.llm_service import LLMService, ReasoningChunk  # noqa: E402

HEADERS = {"X-User-Id": "1", "X-Internal-Secret": "test-secret"}


def _plan(n):
    return {
        "title": "The Salt Road", "blurb": "A courier takes one last job.", "setting": "A desert port.",
        "style": "Third person, past tense.", "ending": "She burns the map and walks home.",
        "cast": [{"name": "Mira", "role": "courier", "arc": "from loner to trusting"}],
        "chapters": [{"title": f"Part {i}", "events": f"Events of chapter {i}.", "ends_with": f"End state {i}.",
                      "plant": ""} for i in range(1, n + 1)],
    }


class FakeModel:
    """Replaces LLMService.generate. Records every request; behaviour per kind
    of call can be scripted."""

    def __init__(self):
        self.calls = []
        self.plan_replies = []        # queued raw replies for plan calls (default: a valid plan)
        self.chapter_delay = 0.0      # seconds each chapter takes
        self.pause_on_chapter = None  # chapter number that waits on `release`
        self.release = None

    def install(self, monkeypatch):
        model = self

        async def generate(llm, messages, stream=False, **kwargs):
            prompt = messages[-1]["content"]
            model.calls.append({"messages": messages, "kwargs": kwargs})
            if "Reply with JSON only" in prompt or "JSON plan only" in prompt:
                reply = model.plan_replies.pop(0) if model.plan_replies else json.dumps(_plan(4))
                yield ReasoningChunk("Thinking about the arc.")
                yield reply
                return
            if prompt.startswith("Write the notes for chapter"):
                yield "Notes: " + prompt.split("\n\n", 1)[1][:60]
                return
            if "Give it a short, evocative title" in prompt:
                yield "\"The Lantern Keeper\""
                return
            chapter = int(prompt.split("Write chapter ", 1)[1].split(" ", 1)[0])
            if model.pause_on_chapter == chapter:
                await model.release.wait()
            yield ReasoningChunk("Plan the scene.")
            await asyncio.sleep(model.chapter_delay)
            yield f"Chapter {chapter}: Part {chapter}\n\n"
            for i in range(30):
                yield f"Sentence {i} of chapter {chapter} goes on for a while with several words. "
            llm.finish_reason = "stop"

        monkeypatch.setattr(LLMService, "generate", generate)

    def chapter_prompts(self):
        return [c["messages"][-1]["content"] for c in self.calls if "Write chapter " in c["messages"][-1]["content"]]


@pytest.fixture()
def client(monkeypatch):
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
    for r in (autowrite.router, stories.router, generation.router):
        app.include_router(r, prefix="/api")
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def model(monkeypatch):
    m = FakeModel()
    m.install(monkeypatch)
    return m


def _wait(client, story_id, statuses=("done", "failed", "stopped"), timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = client.get(f"/api/stories/{story_id}/autowrite", headers=HEADERS).json()
        if s["status"] in statuses:
            return s
        time.sleep(0.05)
    raise AssertionError(f"still {s} after {timeout}s")


def _start(client, **body):
    body = {"card_ids": [1], "length": "short", **body}
    r = client.post("/api/stories/autowrite", json=body, headers=HEADERS)
    assert r.status_code == 200, r.text
    return r.json()


def test_full_run_writes_every_chapter_to_an_ending(client, model):
    story = _start(client)
    assert story["title"] == aw.UNTITLED
    status = _wait(client, story["id"])
    assert status["status"] == "done" and status["chapters_done"] == 4

    detail = client.get(f"/api/stories/{story['id']}", headers=HEADERS).json()
    assert detail["title"] == "The Salt Road"            # named from the plan
    assert detail["synopsis"] == "A courier takes one last job."
    assert detail["has_outline"] is True
    assert "plan" not in detail and "ending" not in json.dumps(detail)  # the outline stays hidden
    segs = detail["segments"]
    assert [s["chapter"] for s in segs] == [1, 2, 3, 4]
    assert all(not s["content"].startswith("Chapter") for s in segs)  # the model's heading is stripped
    assert all(s["summary"].startswith("Notes:") for s in segs)

    outline = client.get(f"/api/stories/{story['id']}/outline", headers=HEADERS).json()
    assert outline["ending"] == "She burns the map and walks home."

    prompts = model.chapter_prompts()
    assert len(prompts) == 4
    assert all("This is not the end of the story" in p for p in prompts[:3])
    assert "This is the final chapter" in prompts[3] and "She burns the map" in prompts[3]
    assert "Open in a scene" in prompts[0] and "Carry straight on" in prompts[1]
    assert "What has happened so far" in prompts[2] and "Chapter 2: Notes:" in prompts[2]
    # The cards and outline form an identical prefix in every chapter call.
    systems = {c["messages"][0]["content"] for c in model.calls if "Write chapter " in c["messages"][-1]["content"]}
    assert len(systems) == 1
    assert "Mira is a courier who distrusts the user." in systems.pop()


def test_given_title_is_kept(client, model):
    story = _start(client, title="My Own Title")
    _wait(client, story["id"])
    assert client.get(f"/api/stories/{story['id']}", headers=HEADERS).json()["title"] == "My Own Title"


def test_bad_plan_is_retried_once(client, model):
    model.plan_replies = ["Sure! Here is a plan: chapter one, chapter two.", json.dumps(_plan(4))]
    story = _start(client)
    assert _wait(client, story["id"])["status"] == "done"
    retry_prompt = [c for c in model.calls if "JSON plan only" in c["messages"][-1]["content"]]
    assert retry_prompt, "the planner should have been asked again"


def test_plan_that_fails_twice_fails_before_any_chapter(client, model):
    model.plan_replies = ["nope", "still nope"]
    story = _start(client)
    status = _wait(client, story["id"])
    assert status["status"] == "failed" and "JSON" in status["error"]
    assert model.chapter_prompts() == []


def test_faithfulness_and_ending_reach_the_planner(client, model):
    story = _start(client, faithfulness=5, ending="twist", idea="A heist on a moving train.")
    _wait(client, story["id"])
    plan_call = model.calls[0]
    prompt = plan_call["messages"][-1]["content"]
    assert "Go off the rails" in prompt and "recasts what came before" in prompt and "moving train" in prompt
    assert plan_call["kwargs"]["temperature"] == aw.PLANNER_TEMPERATURE[5]


def test_stop_then_resume_finishes_without_repeating(client, model):
    model.release = asyncio.Event()
    model.pause_on_chapter = 2
    story = _start(client)
    deadline = time.time() + 5
    while client.get(f"/api/stories/{story['id']}/autowrite", headers=HEADERS).json()["chapters_done"] < 1:
        assert time.time() < deadline
        time.sleep(0.05)
    stopped = client.post(f"/api/stories/{story['id']}/autowrite/stop", headers=HEADERS).json()
    assert stopped["status"] == "stopped" and stopped["chapters_done"] == 1

    model.pause_on_chapter = None
    client.post(f"/api/stories/{story['id']}/autowrite/resume", headers=HEADERS)
    assert _wait(client, story["id"])["status"] == "done"
    chapters = [s["chapter"] for s in client.get(f"/api/stories/{story['id']}", headers=HEADERS).json()["segments"]]
    assert chapters == [1, 2, 3, 4]
    assert sum(1 for c in model.calls if "Reply with JSON only" in c["messages"][-1]["content"]) == 1  # one plan


def test_restart_mid_run_reports_interrupted_and_resumes(client, model):
    story = _start(client)
    _wait(client, story["id"])
    # Simulate a backend restart after chapter 2: progress says "writing", no live task.
    with SessionLocal() as db:
        db.query(StorySegment).filter(StorySegment.story_id == story["id"], StorySegment.chapter > 2).delete()
        s = db.query(Story).get(story["id"])
        state = json.loads(s.autowrite)
        state["status"] = "writing"
        s.autowrite = json.dumps(state)
        db.commit()
    assert client.get(f"/api/stories/{story['id']}/autowrite", headers=HEADERS).json()["status"] == "interrupted"
    client.post(f"/api/stories/{story['id']}/autowrite/resume", headers=HEADERS)
    assert _wait(client, story["id"])["chapters_done"] == 4


def test_steering_note_goes_into_the_next_chapter_then_clears(client, model):
    model.release = asyncio.Event()
    model.pause_on_chapter = 1
    story = _start(client)
    _wait(client, story["id"], statuses=("writing",))
    client.post(f"/api/stories/{story['id']}/autowrite/steer", json={"note": "Introduce a talking camel."}, headers=HEADERS)
    model.release.set()
    _wait(client, story["id"])
    prompts = model.chapter_prompts()
    assert "talking camel" not in prompts[0]   # chapter 1 had already started
    assert "talking camel" in prompts[1]
    assert "talking camel" not in prompts[2]
    assert client.get(f"/api/stories/{story['id']}/autowrite", headers=HEADERS).json()["steer_pending"] == 0


def test_manual_generate_is_refused_while_a_run_is_live(client, model):
    model.release = asyncio.Event()
    model.pause_on_chapter = 1
    story = _start(client)
    _wait(client, story["id"], statuses=("writing",))
    r = client.post("/api/generate/", json={"story_id": story["id"]}, headers=HEADERS)
    assert r.status_code == 409
    model.release.set()
    _wait(client, story["id"])


def test_live_partial_text_is_sent_from_an_offset(client, model):
    model.release = asyncio.Event()
    model.pause_on_chapter = 2
    story = _start(client)
    _wait(client, story["id"], statuses=("writing",))
    run = aw.active_run(story["id"])
    deadline = time.time() + 5
    while run.chapter != 2:
        assert time.time() < deadline
        time.sleep(0.02)
    run.phase, run.raw = "writing", "<think>\nsecret plan\n</think>\nHello there, reader."
    full = client.get(f"/api/stories/{story['id']}/autowrite", headers=HEADERS).json()
    assert full["partial"] == "Hello there, reader." and full["partial_from"] == 0
    tail = client.get(f"/api/stories/{story['id']}/autowrite?from=6", headers=HEADERS).json()
    assert tail["partial"] == "there, reader." and tail["partial_from"] == 6
    stale = client.get(f"/api/stories/{story['id']}/autowrite?from=999", headers=HEADERS).json()
    assert stale["partial_from"] == 0
    model.release.set()
    _wait(client, story["id"])


def test_untitled_manual_story_is_named_after_its_first_chunk(client, model):
    r = client.post("/api/stories/", json={"title": "", "card_ids": [1]}, headers=HEADERS)
    story = r.json()
    assert story["title"] == aw.UNTITLED
    with SessionLocal() as db:
        db.add(StorySegment(story_id=story["id"], order_index=0, content="The lamp guttered as Mira climbed."))
        db.commit()
    asyncio.run(aw.name_story_task(story["id"]))
    assert client.get(f"/api/stories/{story['id']}", headers=HEADERS).json()["title"] == "The Lantern Keeper"


# ── Output-token ceiling ──────────────────────────────────────────────────────

def _llm_with(handler):
    s = Settings(api_base_url="https://example.test/v1", api_key="k", model="m", temperature=0.8, top_p=0.95)
    llm = LLMService(s)
    llm.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return llm


SSE_OK = b'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'


async def _collect(llm, stream):
    out = ""
    async for chunk in llm.generate([{"role": "user", "content": "x"}], stream=stream, max_tokens=500):
        out += chunk
    return out


def test_ceiling_is_generous_and_a_normal_call_is_sent_once():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, content=SSE_OK, headers={"content-type": "text/event-stream"})

    assert asyncio.run(_collect(_llm_with(handler), True)) == "Hi"
    assert len(seen) == 1, "a successful call must not be sent twice"
    assert seen[0]["max_tokens"] == llm_service.MAX_OUTPUT_TOKENS


@pytest.mark.parametrize("stream", [True, False])
def test_refused_ceiling_is_retried_without_one(stream):
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        if "max_tokens" in body:
            return httpx.Response(400, json={"error": {"message": "max_tokens must be <= 8192 for this model"}})
        if stream:
            return httpx.Response(200, content=SSE_OK, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "Hi"}}]})

    assert asyncio.run(_collect(_llm_with(handler), stream)) == "Hi"
    assert len(seen) == 2 and "max_tokens" not in seen[1]


def test_other_errors_are_not_retried():
    seen = []

    def handler(request):
        seen.append(1)
        return httpx.Response(400, json={"error": {"message": "invalid model"}})

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(_collect(_llm_with(handler), True))
    assert len(seen) == 1
