"""Web Push to the user's devices (plans/ios-app.md, Stage 2).

A browser that allows notifications hands over a subscription: an endpoint at
its push service (Apple, Google, Mozilla, Microsoft) and two keys. To notify,
the payload is encrypted with those keys and POSTed to the endpoint, signed
with our VAPID key so the push service knows the pushes come from us.

The VAPID key pair is made on first use and kept in app_secrets, so a deploy
needs no new settings. Set VAPID_PRIVATE_KEY (PEM) to use a key of your own;
changing the key orphans every existing subscription.
"""
import json
import logging
import os
import threading
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
