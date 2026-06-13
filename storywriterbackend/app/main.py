from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from app.database import init_db
from app.routers import cards, stories, generation, settings, auth, chat, adventure

app = FastAPI(title="AI Story Writer", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Ensure upload directories exist
os.makedirs("uploads/cards", exist_ok=True)
os.makedirs("uploads/stories", exist_ok=True)

# Mount static files for uploads
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

app.include_router(cards.router, prefix="/api")
app.include_router(stories.router, prefix="/api")
app.include_router(generation.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(adventure.router, prefix="/api")

@app.on_event("startup")
def on_startup():
    init_db()

@app.get("/")
def root():
    return {"message": "AI Story Writer API"}
