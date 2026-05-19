from __future__ import annotations
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime

class CharacterCardCreate(BaseModel):
    name: str
    description: str = ""
    personality: str = ""
    scenario: str = ""
    first_mes: str = ""
    mes_example: str = ""
    creatorcomment: str = ""
    tags: str = ""
    creator: str = ""
    character_version: str = ""
    alternate_greetings: str = ""
    system_prompt: str = ""
    post_history_instructions: str = ""
    character_book: str = ""
    image_path: str = ""

class CharacterCardOut(CharacterCardCreate):
    id: int
    created_at: datetime
    updated_at: datetime
    class Config:
        from_attributes = True

class StoryCreate(BaseModel):
    title: str
    synopsis: str = ""
    card_ids: Optional[List[int]] = []

class StoryOut(BaseModel):
    id: int
    title: str
    synopsis: str
    created_at: datetime
    updated_at: datetime
    class Config:
        from_attributes = True

class StoryDetailOut(StoryOut):
    segments: List["StorySegmentOut"] = []
    cards: List["StoryCardOut"] = []

class StorySegmentCreate(BaseModel):
    content: str
    order_index: int

class StorySegmentOut(BaseModel):
    id: int
    story_id: int
    order_index: int
    content: str
    summary: str
    is_summary: bool
    created_at: datetime
    class Config:
        from_attributes = True

class StoryCardOut(BaseModel):
    id: int
    story_id: int
    card_id: int
    card: CharacterCardOut
    class Config:
        from_attributes = True

class SteeringInstructionCreate(BaseModel):
    instruction: str

class SteeringInstructionOut(SteeringInstructionCreate):
    id: int
    story_id: int
    created_at: datetime
    class Config:
        from_attributes = True

class SettingsOut(BaseModel):
    id: int
    api_base_url: str
    api_key: str
    model: str
    max_tokens: int
    temperature: float
    context_window: int
    summary_threshold: int
    chunk_size: int
    system_prompt: str
    image_model: str
    class Config:
        from_attributes = True

class SettingsUpdate(BaseModel):
    api_base_url: Optional[str] = None
    api_key: Optional[str] = None
    model: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    context_window: Optional[int] = None
    summary_threshold: Optional[int] = None
    chunk_size: Optional[int] = None
    system_prompt: Optional[str] = None
    image_model: Optional[str] = None

class GenerateRequest(BaseModel):
    story_id: int
    steering: Optional[str] = None

class ImagePromptRequest(BaseModel):
    story_id: int
    segment_id: int

class GenerateResponse(BaseModel):
    segment: StorySegmentOut

class EditSegmentRequest(BaseModel):
    content: str

class SummaryRequest(BaseModel):
    story_id: int
