from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime, ForeignKey, Boolean, JSON, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from datetime import datetime
import os
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

class Story(Base):
    __tablename__ = "stories"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    title = Column(String, nullable=False)
    synopsis = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    segments = relationship("StorySegment", back_populates="story", order_by="StorySegment.order_index", cascade="all, delete-orphan")
    cards = relationship("StoryCard", back_populates="story", cascade="all, delete-orphan")

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
    user_persona_name = Column(String, default="User")
    user_persona_age = Column(String, default="")
    user_persona_gender = Column(String, default="")
    user_persona_detail = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    messages = relationship("ChatMessage", back_populates="chat", cascade="all, delete-orphan")
    memories = relationship("ChatMemory", back_populates="chat", cascade="all, delete-orphan")
    characters = relationship("CharacterCard", secondary="chat_character_links")

class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    chat_id = Column(String(36), ForeignKey("roleplay_chats.id", ondelete="CASCADE"), nullable=False)
    role = Column(String, nullable=False)  # user, assistant, system
    character_name = Column(String, nullable=True)  # To identify who spoke in group chats
    content = Column(Text, default="")
    ooc_note = Column(Text, default="")  # Hidden instruction sent alongside the message
    is_summarized = Column(Boolean, default=False)
    is_extracted = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    chat = relationship("RoleplayChat", back_populates="messages")

class ChatMemory(Base):
    __tablename__ = "chat_memories"
    id = Column(String(36), primary_key=True, index=True, default=lambda: str(uuid.uuid4()))
    chat_id = Column(String(36), ForeignKey("roleplay_chats.id", ondelete="CASCADE"), nullable=False)
    fact = Column(Text, nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    chat = relationship("RoleplayChat", back_populates="memories")
