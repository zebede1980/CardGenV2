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
    updated_at: Optional[datetime] = None
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

class StoryDetailOut(StoryOut):
    segments: List[StorySegmentOut] = []
    cards: List[StoryCardOut] = []

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
    tts_enabled: bool = False
    tts_voice: str = "p230"
    tts_model: str = "tts_models/en/vctk/vits"
    tts_speed: float = 1.0
    auto_mode: bool = False
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
    tts_enabled: Optional[bool] = None
    tts_voice: Optional[str] = None
    tts_model: Optional[str] = None
    tts_speed: Optional[float] = None
    auto_mode: Optional[bool] = None

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

class ChatMessageOut(BaseModel):
    id: str
    chat_id: str
    role: str
    character_name: Optional[str] = None
    content: str
    ooc_note: str
    is_summarized: bool = False
    is_extracted: bool = False
    created_at: datetime
    class Config:
        from_attributes = True

class ChatMemoryOut(BaseModel):
    id: str
    chat_id: str
    fact: str
    is_active: bool
    created_at: datetime
    class Config:
        from_attributes = True

class ChatMessageUpdate(BaseModel):
    content: str

class RoleplayChatCreate(BaseModel):
    title: str
    system_prompt: str = ""
    card_ids: List[int] = []
    user_persona_name: str = "User"
    user_persona_age: str = ""
    user_persona_gender: str = ""
    user_persona_detail: str = ""
    user_persona_card_id: Optional[int] = None

class RoleplayChatUpdate(BaseModel):
    title: Optional[str] = None
    system_prompt: Optional[str] = None
    user_persona_name: Optional[str] = None
    user_persona_age: Optional[str] = None
    user_persona_gender: Optional[str] = None
    user_persona_detail: Optional[str] = None
    user_persona_card_id: Optional[int] = None

class RoleplayChatOut(BaseModel):
    id: str
    user_id: int
    title: str
    system_prompt: str
    summary: str
    user_persona_name: str
    user_persona_age: str
    user_persona_gender: str
    user_persona_detail: str
    user_persona_card_id: Optional[int]
    created_at: datetime
    updated_at: datetime
    class Config:
        from_attributes = True

class RoleplayChatDetailOut(RoleplayChatOut):
    messages: List[ChatMessageOut] = []
    memories: List[ChatMemoryOut] = []
    characters: List[CharacterCardOut] = []

class SendMessageRequest(BaseModel):
    content: str
    ooc_note: Optional[str] = ""
    character_name: Optional[str] = None
    max_input_tokens: Optional[int] = None
    max_output_tokens: Optional[int] = None
    temperature: Optional[float] = None
    repetition_penalty: Optional[float] = None
    impersonate: Optional[bool] = False
