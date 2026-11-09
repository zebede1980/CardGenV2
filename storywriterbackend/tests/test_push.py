"""🔔 Push devices and sending (plans/ios-app.md, Stage 2). The push service is
faked at the HTTP layer, but the encryption is real: each fake device has its
own keys and the test decrypts what would have been sent.

Run from storywriterbackend/:
    uv run --python 3.12 --with-requirements requirements.txt --with pytest python -m pytest tests -q
"""
import json
import os
from base64 import urlsafe_b64decode, urlsafe_b64encode

import http_ece
import pytest
import pywebpush
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_autowrite import HEADERS  # noqa: F401  (sets DATABASE_URL before app imports)

from app.models import AppSecret, Base, PushSubscription, SessionLocal, User, engine
from app.routers import push as push_router
from app.services import push

APPLE = "https://web.push.apple.com/QGuQyavXutnMH1oD"


def _b64(raw: bytes) -> str:
    return urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return urlsafe_b64decode(s + "=" * (-len(s) % 4))


class Device:
    """A browser's side of a subscription: its key pair and auth secret."""

    def __init__(self, endpoint=APPLE):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.secret = os.urandom(16)
        self.endpoint = endpoint

    def subscription(self, **extra):
        pub = self.key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        return {"endpoint": self.endpoint, "keys": {"p256dh": _b64(pub), "auth": _b64(self.secret)}, **extra}

    def read(self, body: bytes) -> dict:
        return json.loads(http_ece.decrypt(body, private_key=self.key, auth_secret=self.secret, version="aes128gcm"))


class FakePushService:
    def __init__(self):
        self.sent = []
        self.status = {}  # endpoint -> status code to answer

    def post(self, url, data=None, headers=None, timeout=None, **kw):
        self.sent.append({"url": url, "data": data, "headers": headers})
        r = pywebpush.requests.Response()
        r.status_code = self.status.get(url, 201)
        r._content = b""
        return r


@pytest.fixture()
def service(monkeypatch):
    s = FakePushService()
    monkeypatch.setattr(pywebpush.requests, "post", s.post)
    return s


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    push._cached.clear()
    with SessionLocal() as db:
        db.add(User(username="cardgen_1", password="x"))
        db.add(User(username="cardgen_2", password="x"))
        db.commit()
    app = FastAPI()
    app.include_router(push_router.router, prefix="/api")
    with TestClient(app) as c:
        yield c


OTHER = {**HEADERS, "X-User-Id": "2"}


def _subscribe(client, device, headers=HEADERS, **extra):
    r = client.post("/api/push/subscribe", json=device.subscription(label="iPhone", origin="https://cards.example.org", **extra),
                    headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def test_the_key_is_made_once_and_kept(client):
    a = client.get("/api/push/key", headers=HEADERS).json()["public_key"]
    push._cached.clear()
    b = client.get("/api/push/key", headers=HEADERS).json()["public_key"]
    assert a == b and len(_unb64(a)) == 65 and _unb64(a)[0] == 4  # an uncompressed P-256 point
    with SessionLocal() as db:
        assert db.query(AppSecret).count() == 1


def test_a_test_push_is_encrypted_for_the_device_and_signed(client, service):
    d = Device()
    _subscribe(client, d)
    r = client.post("/api/push/test", json={}, headers=HEADERS).json()
    assert r["ok"] == 1 and r["failed"] == []
    (sent,) = service.sent
    assert sent["url"] == APPLE
    assert sent["headers"]["Content-Encoding"] == "aes128gcm" and sent["headers"]["Urgency"] == "high"
    assert sent["headers"]["Authorization"].startswith("vapid t=")
    msg = d.read(sent["data"])
    assert msg["web_push"] == 8030
    assert msg["notification"]["navigate"] == "https://cards.example.org/?open=home"
    assert "iPhone" in msg["notification"]["body"]

    # The JWT names the push service as audience and the site as subject.
    jwt = sent["headers"]["Authorization"].split("t=")[1].split(",")[0]
    claims = json.loads(_unb64(jwt.split(".")[1]))
    assert claims["aud"] == "https://web.push.apple.com" and claims["sub"] == "https://cards.example.org"

    devices = client.get("/api/push/devices", headers=HEADERS).json()
    assert devices[0]["last_ok_at"] is not None


def test_only_real_push_services_are_accepted(client):
    for bad in ("http://web.push.apple.com/x", "https://localhost:8000/api/x", "https://storywriterbackend/x",
                "https://push.apple.com.evil.test/x", "javascript:alert(1)"):
        r = client.post("/api/push/subscribe", json=Device(bad).subscription(), headers=HEADERS)
        assert r.status_code == 400, bad
    for good in ("https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc",
                 "https://wns2-par02p.notify.windows.com/w/?token=abc"):
        assert client.post("/api/push/subscribe", json=Device(good).subscription(), headers=HEADERS).status_code == 200


def test_a_bad_origin_is_dropped(client, service):
    d = Device()
    client.post("/api/push/subscribe", json=d.subscription(origin="https://evil.test/path?x"), headers=HEADERS)
    client.post("/api/push/test", json={}, headers=HEADERS)
    assert d.read(service.sent[-1]["data"])["notification"]["navigate"] == "/?open=home"


def test_a_gone_device_is_removed_and_a_failing_one_kept(client, service):
    gone, failing = Device("https://web.push.apple.com/gone"), Device("https://fcm.googleapis.com/fcm/send/x")
    _subscribe(client, gone)
    _subscribe(client, failing)
    service.status = {gone.endpoint: 410, failing.endpoint: 500}
    r = client.post("/api/push/test", json={}, headers=HEADERS).json()
    assert (r["ok"], r["gone"], r["error"]) == (0, 1, 1) and r["failed"][0]["label"] == "iPhone"
    (left,) = client.get("/api/push/devices", headers=HEADERS).json()
    assert left["endpoint"] == failing.endpoint and left["last_error"].startswith("500")


def test_devices_belong_to_their_user(client, service):
    d = Device()
    mine = _subscribe(client, d)
    assert client.get("/api/push/devices", headers=OTHER).json() == []
    assert client.post("/api/push/test", json={}, headers=OTHER).status_code == 404
    assert client.delete(f"/api/push/devices/{mine['id']}", headers=OTHER).json() == {"removed": False}
    assert client.post("/api/push/unsubscribe", json={"endpoint": d.endpoint}, headers=OTHER).json() == {"removed": False}
    # Signing in as someone else on the same device moves it to them.
    _subscribe(client, d, headers=OTHER)
    assert client.get("/api/push/devices", headers=HEADERS).json() == []
    assert len(client.get("/api/push/devices", headers=OTHER).json()) == 1


def test_resubscribing_updates_and_unsubscribing_removes(client, service):
    d = Device()
    first = _subscribe(client, d)
    d.secret = os.urandom(16)  # the browser renewed its keys
    again = _subscribe(client, d)
    assert again["id"] == first["id"]
    client.post("/api/push/test", json={"endpoint": d.endpoint}, headers=HEADERS)
    assert d.read(service.sent[-1]["data"])["notification"]["title"] == "🔔 CardGen"
    assert client.post("/api/push/unsubscribe", json={"endpoint": d.endpoint}, headers=HEADERS).json() == {"removed": True}
    with SessionLocal() as db:
        assert db.query(PushSubscription).count() == 0


def test_notify_user_reaches_every_device(client, service):
    a, b = Device("https://web.push.apple.com/a"), Device("https://fcm.googleapis.com/fcm/send/b")
    _subscribe(client, a)
    _subscribe(client, b)
    with SessionLocal() as db:
        uid = db.query(User).filter(User.username == "cardgen_1").one().id
        assert push.notify_user(db, uid, "Mira", "hey you", "/?open=messenger&id=x", tag="m-x") == {"ok": 2, "gone": 0, "error": 0}
    note = a.read(service.sent[0]["data"])["notification"]
    assert (note["title"], note["tag"], note["navigate"]) == ("Mira", "m-x", "https://cards.example.org/?open=messenger&id=x")
