"""🔔 Push notifications (plans/ios-app.md): devices (Stage 2), and the "it's
done" side (Stage 3): page presence, what to notify about, and the proxy's
report of finished card and picture jobs."""
import re
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import models
from app.database import get_db
from app.routers.auth import get_current_user
from app.services import push

router = APIRouter(prefix="/push", tags=["push"])

ORIGIN_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?$")


class Keys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)


class SubscribeIn(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2048)
    keys: Keys
    label: str = Field(default="", max_length=80)
    origin: str = Field(default="", max_length=200)


class EndpointIn(BaseModel):
    endpoint: str = Field(default="", max_length=2048)


class PresenceIn(BaseModel):
    page: str = Field(min_length=1, max_length=64)
    visible: bool


class PrefsIn(BaseModel):
    kinds: Dict[str, bool] = Field(default_factory=dict)
    privacy: Optional[str] = None


class JobItem(BaseModel):
    label: str = Field(default="", max_length=80)
    ok: bool = True
    error: str = Field(default="", max_length=300)


class JobsDoneIn(BaseModel):
    page: str = Field(default="", max_length=64)
    view: str = Field(default="", max_length=20)
    attached: bool = False
    items: List[JobItem] = Field(min_length=1, max_length=20)


def _out(sub: models.PushSubscription) -> dict:
    return {"id": sub.id, "label": sub.label, "endpoint": sub.endpoint, "created_at": sub.created_at,
            "last_ok_at": sub.last_ok_at, "last_error": sub.last_error or ""}


def _mine(db: Session, user) -> list:
    return (db.query(models.PushSubscription).filter(models.PushSubscription.user_id == user.id)
            .order_by(models.PushSubscription.created_at).all())


@router.get("/key")
def get_key(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return {"public_key": push.public_key(db)}


@router.get("/devices")
def list_devices(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return [_out(s) for s in _mine(db, current_user)]


@router.post("/subscribe")
def subscribe(req: SubscribeIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    if not push.allowed_endpoint(req.endpoint):
        raise HTTPException(status_code=400, detail="That isn't a browser push service.")
    origin = req.origin if ORIGIN_RE.match(req.origin or "") else ""
    sub = db.query(models.PushSubscription).filter(models.PushSubscription.endpoint == req.endpoint).first()
    if not sub:
        sub = models.PushSubscription(endpoint=req.endpoint)
        db.add(sub)
    # A device that signs in as someone else now notifies them instead.
    sub.user_id = current_user.id
    sub.p256dh, sub.auth = req.keys.p256dh, req.keys.auth
    sub.label, sub.origin, sub.last_error = req.label.strip(), origin, ""
    db.commit()
    db.refresh(sub)
    return _out(sub)


@router.post("/unsubscribe")
def unsubscribe(req: EndpointIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    n = (db.query(models.PushSubscription)
         .filter(models.PushSubscription.endpoint == req.endpoint, models.PushSubscription.user_id == current_user.id)
         .delete())
    db.commit()
    return {"removed": bool(n)}


@router.delete("/devices/{device_id}")
def remove_device(device_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    n = (db.query(models.PushSubscription)
         .filter(models.PushSubscription.id == device_id, models.PushSubscription.user_id == current_user.id)
         .delete())
    db.commit()
    return {"removed": bool(n)}


@router.post("/test")
def send_test(req: EndpointIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    subs = [s for s in _mine(db, current_user) if not req.endpoint or s.endpoint == req.endpoint]
    if not subs:
        raise HTTPException(status_code=404, detail="No device has notifications turned on.")
    result = {"ok": 0, "gone": 0, "error": 0, "failed": []}
    for sub in subs:
        label = sub.label or "this device"
        outcome = push.send(db, sub, "🔔 CardGen", f"Notifications work on {label}. Tap to open the app.",
                            "/?open=home", tag="cardgen-test")
        result[outcome] += 1
        if outcome == "error":
            result["failed"].append({"label": label, "error": sub.last_error})
    return result


@router.post("/presence")
def presence(req: PresenceIn, current_user: models.User = Depends(get_current_user)):
    push.set_presence(current_user.id, req.page, req.visible)
    return {}


@router.get("/prefs")
def get_prefs(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return push.load_prefs(db, current_user.id)


@router.put("/prefs")
def put_prefs(req: PrefsIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return push.save_prefs(db, current_user.id, req.model_dump())


# Proxy jobs (character cards, lorebooks, pictures) by the page they started on.
VIEWS = {
    "cardgen": ("cards", "🎭 Character Generator"),
    "playground": ("pictures", "🖼️ Playground"),
    "messenger": ("messenger", "💌 Messenger"),
    "roleplay": ("chat", "💬 Roleplay Chat"),
    "adventure": ("adventure", "🎲 Adventure"),
    "storywriter": ("story", "✍️ Story Writer"),
    "home": ("cards", "CardGen"),
}


def jobs_message(items: List[JobItem]) -> tuple:
    """(generic text, failed) for a batch of finished jobs."""
    bad = [i for i in items if not i.ok]
    good = [i for i in items if i.ok]
    label = lambda i: (i.label or "Generation").strip()
    if len(items) == 1:
        i = items[0]
        if not i.ok:
            reason = (i.error or "").strip().rstrip(".")
            return f"{label(i)} failed{': ' + reason[:120] if reason else ''}.", True
        return f"{label(i)} is ready.", False
    names = ", ".join(dict.fromkeys(label(i) for i in good))
    text = f"{len(good)} ready ({names})" if good else ""
    if bad:
        text += ("; " if text else "") + f"{len(bad)} failed"
    return text + ".", not good


@router.post("/internal/jobs-done")
def jobs_done(req: JobsDoneIn, x_proxy_job: str = Header(None),
              current_user: models.User = Depends(get_current_user)):
    """Called by the proxy (never forwarded from the browser) when the jobs one
    page was running have all finished. Returns whether it pushed, so the proxy
    keeps those results for longer."""
    if x_proxy_job != "1":
        raise HTTPException(status_code=404)
    if not push.away(current_user.id, req.page, reading=req.attached):
        return {"pushed": False}
    view = req.view if req.view in VIEWS else "cardgen"
    kind, name = VIEWS[view]
    generic, failed = jobs_message(req.items)
    r = push.deliver(current_user.id, kind, name=name, generic=generic, path=f"/?open={view}",
                     tag=f"jobs-{view}", failed=failed)
    return {"pushed": "skipped" not in r}
