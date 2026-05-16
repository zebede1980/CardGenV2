from typing import List, Optional
from sqlalchemy.orm import Session
from app.models import Story, StorySegment, CharacterCard, Settings, SteeringInstruction
from app.services.card_parser import get_lorebook_entries
import json

class ContextManager:
    def __init__(self, db: Session, settings: Settings):
        self.db = db
        self.settings = settings
        self.context_window = settings.context_window
        self.chunk_size = settings.chunk_size
        self.summary_threshold = settings.summary_threshold

    def build_prompt(self, story: Story, steering: Optional[str] = None) -> List[dict]:
        messages = []
        system_parts = []

        # Add synopsis
        if story.synopsis:
            system_parts.append(f"Story Synopsis/Memo:\n{story.synopsis}")

        # Add character cards and lorebooks
        for sc in story.cards:
            card: CharacterCard = sc.card
            card_parts = []
            if card.name:
                card_parts.append(f"Name: {card.name}")
            if card.description:
                card_parts.append(f"Description: {card.description}")
            if card.personality:
                card_parts.append(f"Personality: {card.personality}")
            if card.scenario:
                card_parts.append(f"Scenario: {card.scenario}")
            if card.system_prompt:
                card_parts.append(f"System Prompt: {card.system_prompt}")
            if card.post_history_instructions:
                card_parts.append(f"Post-History Instructions: {card.post_history_instructions}")
            
            # Lorebook entries
            if card.character_book:
                entries = get_lorebook_entries(card.character_book)
                if entries:
                    lore_parts = []
                    for entry in entries:
                        lore_parts.append(f"- {entry.get('name', 'Unnamed')}: {entry.get('content', '')}")
                    card_parts.append("Lorebook:\n" + "\n".join(lore_parts))
            
            if card_parts:
                system_parts.append("Character Card:\n" + "\n".join(card_parts))

        # Add recent steering instructions
        recent_steering = self.db.query(SteeringInstruction).filter(
            SteeringInstruction.story_id == story.id
        ).order_by(SteeringInstruction.created_at.desc()).limit(5).all()
        
        if recent_steering:
            steering_parts = [f"- {s.instruction}" for s in reversed(recent_steering)]
            system_parts.append("Author's Steering Notes (do not include in story text):\n" + "\n".join(steering_parts))

        if steering:
            system_parts.append(f"Current Steering Instruction (do not include in story text):\n{steering}")

        # Build story context from segments
        segments = self.db.query(StorySegment).filter(
            StorySegment.story_id == story.id
        ).order_by(StorySegment.order_index).all()

        story_context = self._build_story_context(segments)
        if story_context:
            system_parts.append(f"Story So Far:\n{story_context}")

        # Final system instruction
        system_parts.append(
            "You are a creative story writer. Continue the story from where it left off. "
            "Write a substantial, well-developed next section of the story. "
            "Format your output as flowing prose: use standard paragraph breaks (one blank line between paragraphs). "
            "Do not use bullet points, numbered lists, headers, bold text, or any other special formatting. "
            "Keep paragraphs dense and readable — avoid single-sentence paragraphs or excessive line breaks. "
            "Do not include meta-commentary, do not acknowledge the user or instructions, "
            "and do not include the steering notes in the story text. "
            "Only output the next part of the narrative."
        )

        messages.append({"role": "system", "content": "\n\n".join(system_parts)})
        
        # Add the last segment as user message to continue from
        if segments and not segments[-1].is_summary:
            messages.append({"role": "user", "content": f"Continue the story from here:\n\n{segments[-1].content}"})
        elif not segments:
            messages.append({"role": "user", "content": "Begin writing the story based on the synopsis and character cards provided."})
        else:
            messages.append({"role": "user", "content": "Continue the story from where it left off."})

        return messages

    def _build_story_context(self, segments: List[StorySegment]) -> str:
        if not segments:
            return ""
        
        # If we have many segments, use summaries for old ones and full text for recent
        if len(segments) > self.summary_threshold:
            context_parts = []
            # Summarize old segments if not already summarized
            for seg in segments[:-self.summary_threshold]:
                if seg.is_summary:
                    context_parts.append(f"[Summary] {seg.content}")
                else:
                    context_parts.append(seg.content)
            # Add recent segments in full
            for seg in segments[-self.summary_threshold:]:
                context_parts.append(seg.content)
            return "\n\n".join(context_parts)
        else:
            return "\n\n".join([seg.content for seg in segments])

    def should_summarize(self, segments: List[StorySegment]) -> bool:
        non_summary = [s for s in segments if not s.is_summary]
        return len(non_summary) > self.summary_threshold

    def get_segments_to_summarize(self, segments: List[StorySegment]) -> List[StorySegment]:
        non_summary = [s for s in segments if not s.is_summary]
        # Summarize the oldest half of non-summary segments
        to_summarize_count = len(non_summary) - self.summary_threshold // 2
        return non_summary[:to_summarize_count]
