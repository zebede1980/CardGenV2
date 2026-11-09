from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey, Boolean, JSON, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship, deferred
from datetime import datetime
import os
import json
import uuid

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./storywriter.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, nullable=False, index=True)
    password = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class CharacterCard(Base):
    __tablename__ = "character_cards"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text, default="")
    personality = Column(Text, default="")
    scenario = Column(Text, default="")
    first_mes = Column(Text, default="")
    mes_example = Column(Text, default="")
    creatorcomment = Column(Text, default="")
    tags = Column(Text, default="")
    creator = Column(Text, default="")
    character_version = Column(Text, default="")
    alternate_greetings = Column(Text, default="")
    system_prompt = Column(Text, default="")
    post_history_instructions = Column(Text, default="")
    character_book = Column(Text, default="")  # JSON string of lorebook
    image_path = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class CharacterCardGalleryImage(Base):
    __tablename__ = "character_card_gallery_images"
    id = Column(Integer, primary_key=True, index=True)
    card_id = Column(Integer, ForeignKey("character_cards.id", ondelete="CASCADE"), nullable=False)
    order_index = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class PlaygroundImage(Base):
    """An image the user kept from the Image Playground.

    Only the metadata lives here; the bytes stay on the proxy's disk under the
    user's data dir, exactly as character_card_gallery_images works — see the
    /api/storage/playground-images routes in proxy/server.js.
    """
    __tablename__ = "playground_images"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    # How the image came to be ("Generated (flux-2-pro)", "Edited (…)", "Original"),
    # carried over from the Playground history strip's own label.
    label = Column(Text, default="")
    # The prompt or edit instruction behind it, when there was one — worth keeping
    # since it is usually the only reason one image is worth more than another.
    prompt = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)

class Story(Base):
    __tablename__ = "stories"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String, nullable=False)
    synopsis = Column(Text, default="")
    # Auto-written stories (app/services/story_autowriter.py). `plan` is the
    # hidden outline the writer works to, as JSON; it is only ever sent to the
    # browser by GET /stories/{id}/outline, so the story can stay a surprise.
    # `autowrite` is JSON too: the setup choices and the run's progress.
    plan = Column(Text, default="")
    autowrite = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    segments = relationship("StorySegment", back_populates="story", order_by="StorySegment.order_index", cascade="all, delete-orphan")
    cards = relationship("StoryCard", back_populates="story", cascade="all, delete-orphan")

    @property
    def has_outline(self) -> bool:
        return bool(self.plan)

    @property
    def is_autowritten(self) -> bool:
        return bool(self.autowrite)

    @property
    def characters(self):
        """The attached cards in the order they were added (for the story list)."""
        return [sc.card for sc in sorted(self.cards, key=lambda sc: sc.id) if sc.card is not None]

class StoryCard(Base):
    __tablename__ = "story_cards"
    id = Column(Integer, primary_key=True, index=True)
    story_id = Column(Integer, ForeignKey("stories.id"), nullable=False)
    card_id = Column(Integer, ForeignKey("character_cards.id"), nullable=False)
    story = relationship("Story", back_populates="cards")
    card = relationship("CharacterCard")

class StorySegment(Base):
    __tablename__ = "story_segments"
    id = Column(Integer, primary_key=True, index=True)
    story_id = Column(Integer, ForeignKey("stories.id"), nullable=False)
    order_index = Column(Integer, nullable=False)
    content = Column(Text, default="")
    summary = Column(Text, default="")
    is_summary = Column(Boolean, default=False)
    is_summarized = Column(Boolean, default=False)
    # Cached speaker attribution for TTS: a JSON array of {"speaker", "text"}
    # objects covering this segment, produced once after generation rather than
    # re-derived by an LLM call every time the segment is played. Empty string
    # means "not attributed yet" — playback falls back to doing it on demand.
    speaker_map = Column(Text, default="")
    # 1-based chapter of an auto-written story; empty for hand-driven segments.
    chapter = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    story = relationship("Story", back_populates="segments")

class Settings(Base):
    __tablename__ = "settings"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, unique=True)
    api_base_url = Column(Text, default="https://api.openai.com/v1")
    api_key = Column(Text, default="")
    model = Column(Text, default="gpt-4o")
    max_tokens = Column(Integer, default=2048)
    temperature = Column(Float, default=0.8)
    top_p = Column(Float, default=0.95)  # nucleus sampling; clips the junk tail
    context_window = Column(Integer, default=8000)
    summary_threshold = Column(Integer, default=10)  # segments before summarizing
    chunk_size = Column(Integer, default=800)  # target tokens per generation chunk
    system_prompt = Column(Text, default="")  # global author instructions injected into every generation
    image_model = Column(Text, default="")  # override image model for story illustration (blank = use CardGen active)
    # TTS settings
    tts_enabled = Column(Boolean, default=False)
    tts_voice = Column(String, default="p230")  # Speaker ID for multi-speaker models (VCTK)
    tts_model = Column(String, default="tts_models/en/vctk/vits")
    tts_speed = Column(Float, default=1.0)
    auto_mode = Column(Boolean, default=False)  # Auto-generate next chunk after narration

class SteeringInstruction(Base):
    __tablename__ = "steering_instructions"
    id = Column(Integer, primary_key=True, index=True)
    story_id = Column(Integer, ForeignKey("stories.id"), nullable=False)
    instruction = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class ChatCharacterLink(Base):
    __tablename__ = "chat_character_links"
    chat_id = Column(String(36), ForeignKey("roleplay_chats.id", ondelete="CASCADE"), primary_key=True)
    card_id = Column(Integer, ForeignKey("character_cards.id", ondelete="CASCADE"), primary_key=True)

class RoleplayChat(Base):
    __tablename__ = "roleplay_chats"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String, nullable=False, default="New Chat")
    system_prompt = Column(Text, default="")
    summary = Column(Text, default="")
    writing_style = Column(String, default="")
    response_length = Column(String, default="")
    user_persona_name = Column(String, default="User")
    user_persona_age = Column(String, default="")
    user_persona_gender = Column(String, default="")
    user_persona_detail = Column(Text, default="")
    user_persona_card_id = Column(Integer, ForeignKey("character_cards.id"), nullable=True)
    # 'roleplay' (Roleplay Chat) or 'messenger' (💌 Messenger: dialogue only, see messenger.py)
    mode = Column(String, default="roleplay", nullable=False)
    # Messenger settings as JSON: style, relationship, time awareness, check-ins, length…
    messenger = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    @property
    def messenger_config(self) -> dict:
        return _json_dict(self.messenger)

    messages = relationship("ChatMessage", back_populates="chat", cascade="all, delete-orphan")
    memories = relationship("ChatMemory", back_populates="chat", cascade="all, delete-orphan")
    characters = relationship("CharacterCard", secondary="chat_character_links")

class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    chat_id = Column(String(36), ForeignKey("roleplay_chats.id", ondelete="CASCADE"), nullable=False)
    role = Column(String, nullable=False)  # user, assistant, system
    avatar_url = Column(String, nullable=True)
    character_name = Column(String, nullable=True)  # To identify who spoke in group chats
    content = Column(Text, default="")
    ooc_note = Column(Text, default="")  # Hidden instruction sent alongside the message
    reaction = Column(String, default="")  # Messenger tapback on this message (by the other side)
    is_summarized = Column(Boolean, default=False)
    is_extracted = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    chat = relationship("RoleplayChat", back_populates="messages")
    photos = relationship("ChatPhoto", back_populates="message", cascade="all, delete-orphan")

class ChatPhoto(Base):
    """A 💌 Messenger photo. The message holds a `<photo id="…"/>` line where it
    sits in the burst; the picture itself is fetched on its own (it can be MBs).
    status: pending (a character's, not drawn yet), done, failed, described (yours,
    words only: a photo you described rather than sent)."""
    __tablename__ = "chat_photos"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    chat_id = Column(String(36), ForeignKey("roleplay_chats.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id = Column(String(36), ForeignKey("chat_messages.id", ondelete="CASCADE"), nullable=True, index=True)
    owner = Column(String, nullable=False)  # 'char' or 'user'
    sender = Column(String, default="")  # who sent it (a card name, or the persona)
    description = Column(Text, default="")
    prompt = Column(Text, default="")
    image = deferred(Column(Text, default=""))  # data URI or URL; loaded only when asked for
    status = Column(String, default="pending")
    created_at = Column(DateTime, default=datetime.utcnow)

    message = relationship("ChatMessage", back_populates="photos")

class ChatMemory(Base):
    __tablename__ = "chat_memories"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    chat_id = Column(String(36), ForeignKey("roleplay_chats.id", ondelete="CASCADE"), nullable=False)
    fact = Column(Text, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    chat = relationship("RoleplayChat", back_populates="memories")

def _json_dict(raw) -> dict:
    try:
        value = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


class AdventureCharacterLink(Base):
    __tablename__ = "adventure_character_links"
    adventure_id = Column(String(36), ForeignKey("adventure_sessions.id", ondelete="CASCADE"), primary_key=True)
    card_id = Column(Integer, ForeignKey("character_cards.id", ondelete="CASCADE"), primary_key=True)

class AdventureSession(Base):
    __tablename__ = "adventure_sessions"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String, nullable=False, default="New Adventure")
    starting_scenario = Column(Text, default="")
    summary = Column(Text, default="")
    system_prompt = Column(Text, default="")
    # JSON: play style, persona, length/style presets, dice, ending arc (see adventure.py _config).
    play_config = Column(Text, default="")
    # JSON journal (goals, items, people, threads) and how many beats it covers.
    journal = Column(Text, default="")
    journal_at = Column(Integer, default=0)
    # Named automatically after the first beat until the user renames it.
    title_auto = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    actions = relationship("AdventureAction", back_populates="session", cascade="all, delete-orphan", order_by="AdventureAction.order_index")
    characters = relationship("CharacterCard", secondary="adventure_character_links")

    @property
    def config(self) -> dict:
        return _json_dict(self.play_config)

    @property
    def journal_data(self) -> dict:
        return _json_dict(self.journal)

class AdventureAction(Base):
    __tablename__ = "adventure_actions"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String(36), ForeignKey("adventure_sessions.id", ondelete="CASCADE"), nullable=False)
    order_index = Column(Integer, nullable=False)
    content = Column(Text, default="")  # The generated story text or the user's choice text
    role = Column(String, nullable=False)  # 'system', 'user' (choice), 'assistant' (story)
    options = Column(Text, default="")  # JSON list of {text, risk} (older rows: plain strings)
    is_summarized = Column(Boolean, default=False)
    roll = Column(Text, default="")  # JSON dice roll on a risky choice (user rows)
    image = Column(Text, default="")  # scene picture URL or data URI (assistant rows)
    image_prompt = Column(Text, default="")
    
    @property
    def has_image(self) -> bool:
        return bool(self.image)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    session = relationship("AdventureSession", back_populates="actions")

class GlobalConfig(Base):
    __tablename__ = "global_configs"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True)
    config_data = Column(JSON, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class SavedPrompt(Base):
    __tablename__ = "saved_prompts"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    data = Column(JSON, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class HistoryItem(Base):
    __tablename__ = "history_items"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    data = Column(JSON, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class Lorebook(Base):
    __tablename__ = "lorebooks"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    data = Column(JSON, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class AlternateGreeting(Base):
    __tablename__ = "alternate_greetings"
    id = Column(String, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    data = Column(JSON, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class SavedUserPersona(Base):
    __tablename__ = "saved_user_personas"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String, nullable=False)
    age = Column(String, default="")
    gender = Column(String, default="")
    detail = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)

