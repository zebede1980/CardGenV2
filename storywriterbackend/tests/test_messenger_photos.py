"""💌 Messenger photos (plans/messenger-photos.md) against a fake model.

Run from storywriterbackend/:
    uv run --python 3.12 --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
from test_messenger import HEADERS, _detail, _new, _send, client, model  # noqa: F401  (fixtures)

from app.models import ChatPhoto, SessionLocal
from app.services import messenger_prompt as mp

PNG = "data:image/png;base64,iVBORw0KGgo="
IDS = iter(f"00000000-0000-0000-0000-{i:012d}" for i in range(1, 100))


def _ids():
    return lambda: next(IDS)


def _final(ev):
    return next(e for e in ev if e["type"] == "final")


def test_a_photo_gets_its_own_bubble_in_a_text_burst():
    text, photos = mp.lift_photos("omg look\n<photo>Selfie at the beach, red bikini, squinting.</photo> so hot today",
                                  ["Mira"], False, new_id=_ids())
    (pid, sender, desc), = photos
    assert sender == "Mira" and desc == "Selfie at the beach, red bikini, squinting."
    assert text == f'omg look\n\n<photo id="{pid}"/>\n\nso hot today'


def test_a_group_photo_keeps_its_sender_and_the_cap_holds():
    text, photos = mp.lift_photos("Ann: <photo>Ann at a gig.</photo>\nAnnabel: <photo>Annabel reading.</photo>\n"
                                  "Ann: <photo>Another one.</photo>", ["Annabel", "Ann"], True, new_id=_ids())
    assert [(s, d) for _, s, d in photos] == [("Ann", "Ann at a gig."), ("Annabel", "Annabel reading.")]
    lines = text.split("\n")
    assert lines[0] == f'Ann: <photo id="{photos[0][0]}"/>' and lines[1].startswith("Annabel: <photo id=")
    assert len(lines) == 2  # the third photo is over the cap and dropped


def test_photos_are_dropped_when_not_allowed_and_an_unclosed_tag_still_counts():
    text, photos = mp.lift_photos("hey\n\n<photo>Selfie.</photo>", ["Mira"], False, allowed=False)
    assert (text, photos) == ("hey", [])
    _, photos = mp.lift_photos("look <photo>Her new haircut, close-up", ["Mira"], False)
    assert photos[0][2] == "Her new haircut, close-up"


def test_a_reply_with_a_photo_is_stored_pending_and_drawn_later(client, model):
    model.replies = [["here u go\n\n<photo>Mirror selfie in her bedroom, red dress.</photo>"]]
    m = _new(client)
    _, ev = _send(client, m["id"], "send me a pic?")
    final = _final(ev)
    (photo,) = final["photos"]
    assert photo["status"] == "pending" and photo["sender"] == "Mira" and photo["owner"] == "char"
    assert final["content"] == f'here u go\n\n<photo id="{photo["id"]}"/>'

    listed = client.get(f"/api/messenger/{m['id']}/photos", headers=HEADERS).json()
    assert [(p["id"], p["has_image"]) for p in listed] == [(photo["id"], False)]
    assert client.get("/api/messenger/", headers=HEADERS).json()[0]["last"] == "here u go 📷 Photo"

    url = f"/api/messenger/{m['id']}/photos/{photo['id']}"
    assert client.put(url, json={"image": "javascript:alert(1)"}, headers=HEADERS).status_code == 400
    r = client.put(url, json={"image": PNG, "prompt": "Make a new picture…"}, headers=HEADERS)
    assert r.json()["status"] == "done" and r.json()["has_image"] is True
    got = client.get(url, headers=HEADERS).json()
    assert got["image"] == PNG and got["prompt"] == "Make a new picture…"

    _send(client, m["id"], "wow")
    history = [x["content"] for x in model.reply_prompts()[-1]]
    assert "here u go\n\n[Mira sent a photo: Mirror selfie in her bedroom, red dress.]" in history


def test_the_photo_rule_follows_the_setting_and_style(client, model):
    m = _new(client)
    _send(client, m["id"], "hi")
    assert "<photo>what the photo shows</photo>" in model.reply_prompts()[-1][0]["content"]
    assert "now and then on your own" in model.reply_prompts()[-1][0]["content"]
    for settings in ({"photos": "never"}, {"style": "conversation"}):
        model.replies = [["hey <photo>Selfie.</photo>"]]
        m = _new(client, **settings)
        _, ev = _send(client, m["id"], "hi")
        assert "<photo>" not in model.reply_prompts()[-1][0]["content"]
        assert _final(ev)["photos"] == [] and "photo" not in _final(ev)["content"]


def test_you_can_send_a_real_or_a_described_photo(client, model):
    m = _new(client)
    url = f"/api/messenger/{m['id']}/photos"
    assert client.post(url, json={}, headers=HEADERS).status_code == 400
    real = client.post(url, json={"image": PNG, "description": "Joe's dog asleep on the sofa"}, headers=HEADERS).json()
    told = client.post(url, json={"description": "Joe in a suit, thumbs up"}, headers=HEADERS).json()
    assert real["status"] == "done" and told["status"] == "described" and told["has_image"] is False
    _send(client, m["id"], f"{real['marker']}\n\nlook at him\n\n{told['marker']}")
    user_msg = _detail(client, m["id"])["messages"][0]
    assert real["marker"] in user_msg["content"] and told["marker"] in user_msg["content"]
    with SessionLocal() as db:
        assert {p.message_id for p in db.query(ChatPhoto).all()} == {user_msg["id"]}
    prompt = [x["content"] for x in model.reply_prompts()[-1]]
    assert ("[Joe sent a photo: Joe's dog asleep on the sofa]\n\nlook at him\n\n"
            "[Joe sent a photo: Joe in a suit, thumbs up]") in prompt
    # Only a character's photo is drawn
    assert client.put(f"{url}/{real['id']}", json={"image": PNG}, headers=HEADERS).status_code == 400


def test_a_marker_can_only_be_used_once_and_only_in_its_own_chat(client, model):
    a, b = _new(client), _new(client)
    told = client.post(f"/api/messenger/{a['id']}/photos", json={"description": "A sunset"}, headers=HEADERS).json()
    r, _ = _send(client, b["id"], told["marker"])
    assert r.status_code == 400  # nothing left to send once the foreign marker goes
    _send(client, a["id"], "ok " + told["marker"])
    _send(client, a["id"], "again " + told["marker"])
    assert [x["content"] for x in _detail(client, a["id"])["messages"] if x["role"] == "user"] == [
        "ok " + told["marker"], "again"]


def test_regen_and_delete_take_the_reply_photos_with_them(client, model):
    model.replies = [["<photo>Selfie.</photo>"], ["no pics today"]]
    m = _new(client)
    _send(client, m["id"], "pic?")
    with SessionLocal() as db:
        assert db.query(ChatPhoto).count() == 1
    _send(client, m["id"], kind="regen")
    with SessionLocal() as db:
        assert db.query(ChatPhoto).count() == 0
