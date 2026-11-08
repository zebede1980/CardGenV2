"""The story list carries who's in each story (for the portraits), and no text.

Run from storywriterbackend/:
    uv run --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
from test_autowrite import HEADERS, client  # noqa: F401  (client is a fixture)

from app.models import CharacterCard, SessionLocal, User


def _add_card(name):
    with SessionLocal() as db:
        user = db.query(User).first()
        card = CharacterCard(user_id=user.id, name=name)
        db.add(card)
        db.commit()
        return card.id


def test_list_names_each_storys_characters_in_the_order_added(client):
    tobias = _add_card("Tobias")
    r = client.post("/api/stories/", json={"title": "Two of them", "card_ids": [tobias, 1]}, headers=HEADERS)
    assert r.status_code == 200, r.text
    client.post("/api/stories/", json={"title": "Nobody"}, headers=HEADERS)

    stories = {s["title"]: s for s in client.get("/api/stories/", headers=HEADERS).json()}
    assert stories["Two of them"]["characters"] == [{"id": tobias, "name": "Tobias"}, {"id": 1, "name": "Mira"}]
    assert stories["Nobody"]["characters"] == []
    assert "segments" not in stories["Two of them"]
    assert "description" not in stories["Two of them"]["characters"][0]


def test_detached_card_leaves_the_list(client):
    story = client.post("/api/stories/", json={"title": "Solo", "card_ids": [1]}, headers=HEADERS).json()
    assert client.delete(f"/api/stories/{story['id']}/cards/1", headers=HEADERS).status_code == 200
    listed = next(s for s in client.get("/api/stories/", headers=HEADERS).json() if s["id"] == story["id"])
    assert listed["characters"] == []
