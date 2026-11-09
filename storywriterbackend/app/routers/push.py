"""🔔 Push notification devices (plans/ios-app.md, Stage 2): subscribe a device,
list and remove them, send a test. Sending for real work happens through
services/push.notify_user."""
import re

from fastapi import APIRouter, Depends, HTTPException
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
