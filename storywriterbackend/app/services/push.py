"""Web Push to the user's devices (plans/ios-app.md, Stage 2).

A browser that allows notifications hands over a subscription: an endpoint at
its push service (Apple, Google, Mozilla, Microsoft) and two keys. To notify,
the payload is encrypted with those keys and POSTed to the endpoint, signed
with our VAPID key so the push service knows the pushes come from us.

The VAPID key pair is made on first use and kept in app_secrets, so a deploy
needs no new settings. Set VAPID_PRIVATE_KEY (PEM) to use a key of your own;
changing the key orphans every existing subscription.
"""
import asyncio
import functools
import json
import logging
import os
import re
import threading
import time
from base64 import urlsafe_b64encode
from datetime import datetime
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid
from pywebpush import WebPushException, webpush
from sqlalchemy.exc import IntegrityError

from app import models

logger = logging.getLogger(__name__)

VAPID_SECRET = "vapid_private_pem"
TTL_SECONDS = 24 * 3600

# The server POSTs to whatever endpoint a browser hands it, so only real push
# services are accepted (otherwise "send a test" could be aimed at an internal host).
PUSH_HOSTS = ("push.apple.com", "fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com")

_lock = threading.Lock()
_cached = {}  # pem -> (Vapid, public key b64url)


def allowed_endpoint(url: str) -> bool:
    p = urlparse(url or "")
    host = (p.hostname or "").lower()
    return p.scheme == "https" and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)


def _private_pem(db) -> str:
    env = os.getenv("VAPID_PRIVATE_KEY", "").strip()
    if env:
        return env.replace("\\n", "\n")
    row = db.get(models.AppSecret, VAPID_SECRET)
    if row:
        return row.value
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    db.add(models.AppSecret(name=VAPID_SECRET, value=pem))
    try:
        db.commit()
    except IntegrityError:  # another request made it first
        db.rollback()
        return db.get(models.AppSecret, VAPID_SECRET).value
    return pem


def _keys(db):
    pem = _private_pem(db)
    with _lock:
        if pem not in _cached:
            vapid = Vapid.from_pem(pem.encode())
            raw = vapid.public_key.public_bytes(serialization.Encoding.X962,
                                                serialization.PublicFormat.UncompressedPoint)
            _cached[pem] = (vapid, urlsafe_b64encode(raw).decode().rstrip("="))
        return _cached[pem]


def public_key(db) -> str:
    """The applicationServerKey the browser subscribes with."""
    return _keys(db)[1]


def payload(title: str, body: str, url: str, tag: str = "") -> str:
    """Apple's declarative push format (Safari 18.4+ can show it without running
    the service worker); sw.js reads the same fields on every other browser."""
    note = {"title": title, "body": body, "navigate": url, "lang": "en-GB"}
    if tag:
        note["tag"] = tag
    return json.dumps({"web_push": 8030, "notification": note})


def send(db, sub: models.PushSubscription, title: str, body: str, path: str = "/", tag: str = "") -> str:
    """Push to one device. Returns 'ok', 'gone' (the device unsubscribed; its row
    is deleted) or 'error' (kept, with last_error set)."""
    origin = sub.origin or ""
    url = origin + path if origin else path
    subject = os.getenv("VAPID_SUBJECT") or (origin if origin.startswith("https://") else "mailto:push@example.com")
    vapid, _ = _keys(db)
    try:
        webpush({"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
                data=payload(title, body, url, tag), vapid_private_key=vapid,
                vapid_claims={"sub": subject}, ttl=TTL_SECONDS, headers={"Urgency": "high"}, timeout=10)
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            db.delete(sub)
            db.commit()
            return "gone"
        sub.last_error = f"{status or ''} {e.message}".strip()[:500]
        db.commit()
        logger.warning("push to %s failed: %s", sub.label or sub.id, sub.last_error)
        return "error"
    except Exception as e:  # network trouble reaching the push service
        sub.last_error = str(e)[:500]
        db.commit()
        logger.warning("push to %s failed: %s", sub.label or sub.id, e)
        return "error"
    sub.last_ok_at = datetime.utcnow()
    sub.last_error = ""
    db.commit()
    return "ok"


def notify_user(db, user_id: int, title: str, body: str, path: str = "/", tag: str = "") -> dict:
    """Push to every device of one user."""
    counts = {"ok": 0, "gone": 0, "error": 0}
    for sub in db.query(models.PushSubscription).filter(models.PushSubscription.user_id == user_id).all():
        counts[send(db, sub, title, body, path, tag)] += 1
    return counts


# ── "It's done" notifications (plans/ios-app.md, Stage 3) ───────────────────
#
# A generation that finishes while you're looking at the app needs no push. The
# browser can't run anything while the phone is locked, so each page tells the
# server when it is hidden or shown (POST /push/presence, keyed by a random id
# per page load, sent as X-Page-Id with every request). A generation that ends
# while the page that started it is hidden pushes to all of that user's devices.

KINDS = ("cards", "pictures", "chat", "messenger", "adventure", "story")
PRIVACY = ("preview", "name", "nothing")
DEFAULT_PREFS = {"kinds": {k: True for k in KINDS}, "privacy": "name"}

PRESENCE_TTL_SECONDS = 24 * 3600
_presence: dict = {}  # page id -> (user_id, visible, time.monotonic())
_presence_lock = threading.Lock()


def clean_page_id(page) -> str:
    page = (page or "").strip()
    return page if 0 < len(page) <= 64 and all(c.isalnum() or c in "-_" for c in page) else ""


def set_presence(user_id: int, page: str, visible: bool) -> None:
    page = clean_page_id(page)
    if not page:
        return
    now = time.monotonic()
    with _presence_lock:
        if len(_presence) > 500:
            for k in [k for k, v in _presence.items() if now - v[2] > PRESENCE_TTL_SECONDS]:
                del _presence[k]
        _presence[page] = (user_id, bool(visible), now)


def page_state(user_id: int, page) -> str:
    """'visible', 'hidden', or '' when the page never said (an old client, or
    the backend restarted since)."""
    with _presence_lock:
        entry = _presence.get(clean_page_id(page))
    if not entry or entry[0] != user_id or time.monotonic() - entry[2] > PRESENCE_TTL_SECONDS:
        return ""
    return "visible" if entry[1] else "hidden"


def away(user_id: int, page, reading=None) -> bool:
    """Should a finished generation be pushed? Yes when its page is hidden. A page
    that never reported falls back on `reading`: whether something was still
    reading the result when it finished (None: no way to tell, so no push)."""
    state = page_state(user_id, page)
    if state:
        return state == "hidden"
    return reading is False


def load_prefs(db, user_id: int) -> dict:
    row = db.get(models.PushPrefs, user_id)
    try:
        saved = json.loads(row.prefs) if row and row.prefs else {}
    except ValueError:
        saved = {}
    kinds = dict(DEFAULT_PREFS["kinds"])
    for k, v in (saved.get("kinds") or {}).items():
        if k in kinds:
            kinds[k] = bool(v)
    privacy = saved.get("privacy") if saved.get("privacy") in PRIVACY else DEFAULT_PREFS["privacy"]
    return {"kinds": kinds, "privacy": privacy}


def save_prefs(db, user_id: int, prefs: dict) -> dict:
    merged = load_prefs(db, user_id)
    for k, v in (prefs.get("kinds") or {}).items():
        if k in merged["kinds"]:
            merged["kinds"][k] = bool(v)
    if prefs.get("privacy") in PRIVACY:
        merged["privacy"] = prefs["privacy"]
    row = db.get(models.PushPrefs, user_id)
    if not row:
        row = models.PushPrefs(user_id=user_id)
        db.add(row)
    row.prefs = json.dumps(merged)
    row.updated_at = datetime.utcnow()
    db.commit()
    return merged


_PHOTO_TAG = re.compile(r"<photo\b[^>]*/>|<photo\b[^>]*>.*?</photo>", re.S | re.I)


def excerpt(text: str, limit: int = 140) -> str:
    """The start of a reply as plain text, for a lock-screen preview."""
    text = re.sub(r"<think>.*?(</think>|$)", "", text or "", flags=re.S)
    text = _PHOTO_TAG.sub(" 📷 Photo ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[*_`#>~]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(",;:—-") + "…"


def compose(privacy: str, name: str, generic: str, preview: str = "", failed: bool = False) -> tuple:
    """(title, body) for the lock screen. 'nothing' says only that something is
    ready; 'name' says who or what; 'preview' adds the start of the text."""
    if privacy == "nothing":
        return "CardGen", ("Something you were waiting for didn't finish." if failed
                           else "Something you were waiting for is ready.")
    if privacy == "preview" and preview and not failed:
        return name, preview
    return name, generic


def deliver(user_id: int, kind: str, *, name: str, generic: str, preview: str = "", path: str = "/",
            tag: str = "", failed: bool = False) -> dict:
    """Blocking: checks the user's prefs and pushes. Runs off the event loop."""
    try:
        with models.SessionLocal() as db:
            prefs = load_prefs(db, user_id)
            if not prefs["kinds"].get(kind, True):
                return {"ok": 0, "gone": 0, "error": 0, "skipped": "off"}
            title, body = compose(prefs["privacy"], name, generic, preview, failed)
            return notify_user(db, user_id, title, body, path, tag)
    except Exception:
        logger.exception("done-push for user %s failed", user_id)
        return {"ok": 0, "gone": 0, "error": 1}


def done(user_id: int, kind: str, page=None, *, reading=None, **message) -> bool:
    """Call when a generation ends (not when the user stopped it). Pushes in the
    background if nobody is looking; returns whether it will push."""
    if not away(user_id, page, reading):
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        deliver(user_id, kind, **message)
    else:
        loop.run_in_executor(None, functools.partial(deliver, user_id, kind, **message))
    return True
