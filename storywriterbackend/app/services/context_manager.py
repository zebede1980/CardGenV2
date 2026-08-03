from typing import List, Optional
from sqlalchemy.orm import Session
from app.models import Story, StorySegment, CharacterCard, Settings, SteeringInstruction
from app.services.card_parser import extract_relevant_lorebook_entries
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

        # Global author instructions (set by user in Generation Settings)
        if self.settings.system_prompt and self.settings.system_prompt.strip():
            system_parts.append(f"Author's Global Instructions:\n{self.settings.system_prompt.strip()}")

        # Add synopsis
        if story.synopsis:
            system_parts.append(f"Story Synopsis/Memo:\n{story.synopsis}")

        # Build story context from segments
        segments = self.db.query(StorySegment).filter(
            StorySegment.story_id == story.id
        ).order_by(StorySegment.order_index).all()
        
        # Pre-calculate recent history text for lorebook extraction
        recent_history_text = " ".join([s.content for s in segments[-3:]])

        # Add character cards and lorebooks
        for sc in story.cards:
            card: CharacterCard = sc.card

            # Substitute SillyTavern template variables so the LLM sees real names,
            # not literal {{char}} / {{user}} placeholders.
            char_name = card.name or "Character"
            def _sub(text: str) -> str:
                if not text:
                    return text
                return (text
                        .replace("{{char}}", char_name)
                        .replace("{{Char}}", char_name)
                        .replace("{{CHAR}}", char_name)
                        .replace("{{user}}", "the user")
                        .replace("{{User}}", "the user")
                        .replace("{{USER}}", "the user"))

            card_parts = []
            if card.name:
                card_parts.append(f"Name: {card.name}")
            if card.description:
                card_parts.append(f"Description: {_sub(card.description)}")
            if card.personality:
                card_parts.append(f"Personality: {_sub(card.personality)}")
            if card.scenario:
                card_parts.append(f"Scenario: {_sub(card.scenario)}")
            # card.system_prompt: per-character author instructions (e.g. language, tone)
            # Only include if non-empty; many cards leave this blank or use it for
            # site-specific metadata that would bloat context.
            if card.system_prompt and card.system_prompt.strip():
                card_parts.append(f"Character Instructions:\n{_sub(card.system_prompt.strip())}")
            # post_history_instructions is a SillyTavern field intended to come AFTER
            # the chat history. In story mode there is no turn-by-turn history, so we
            # append it here at the end of the card block as a final authoring note.
            if card.post_history_instructions and card.post_history_instructions.strip():
                card_parts.append(f"Additional Character Notes:\n{_sub(card.post_history_instructions.strip())}")
            
            # Lorebook entries
            if card.character_book:
                relevant_lore = extract_relevant_lorebook_entries(card.character_book, recent_history_text)
                if relevant_lore:
                    card_parts.append("Lorebook:\n" + "\n".join(relevant_lore))
            
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

        # Final system instruction
        final_system_instruction = (
            "You are a creative story writer. Continue the story from where it left off. "
            "Write a substantial, well-developed next section of the story. "
            "Format your output as flowing prose: use standard paragraph breaks (one blank line between paragraphs). "
            "Do not use bullet points, numbered lists, headers, bold text, or any other special formatting. "
            "Keep paragraphs dense and readable — avoid single-sentence paragraphs or excessive line breaks. "
            "Do not include meta-commentary, do not acknowledge the user or instructions, "
            "and do not include the steering notes in the story text. "
            "Always finish your output at a natural sentence or paragraph boundary — never mid-sentence. "
            "Only output the next part of the narrative."
        )

        # ── Token budget ──────────────────────────────────────────────────────
        # Reserve space for: system header parts (already built), final instruction,
        # the user continuation prompt, AND the model's output (max_tokens).
        # This ensures we never push so much story history that the model has no
        # room left for its output — which is what causes gibberish.
        system_text_so_far = "\n\n".join(system_parts) + "\n\n" + final_system_instruction
        system_tokens_so_far = len(system_text_so_far) // 4

        # The last segment will be the user message (separate from "Story So Far")
        last_segment = segments[-1] if segments and not segments[-1].is_summary else None
        user_msg_tokens = (len(last_segment.content) // 4 + 50) if last_segment else 50

        # max_tokens is the output budget the LLM needs
        output_tokens = self.settings.max_tokens

        available_context_tokens = max(
            500,
            self.context_window
            - system_tokens_so_far
            - user_msg_tokens
            - output_tokens
        )

        # Build story context, explicitly EXCLUDING the last segment
        # (it will be sent as the user message to avoid double-sending).
        context_segments = segments[:-1] if last_segment else segments
        story_context = self._build_story_context(context_segments, available_context_tokens)
        if story_context:
            system_parts.append(f"Story So Far:\n{story_context}")

        system_parts.append(final_system_instruction)

        messages.append({"role": "system", "content": "\n\n".join(system_parts)})
        
        # User message: ask the model to continue from the most recent segment.
        # Sending it as the user turn (not buried in the system prompt) gives the
        # model a clear, unambiguous anchor point for the next generation.
        if last_segment:
            messages.append({"role": "user", "content": f"Continue the story from here:\n\n{last_segment.content}"})
        elif not segments:
            messages.append({"role": "user", "content": "Begin writing the story based on the synopsis and character cards provided."})
        else:
            # last segment is a summary — don't repeat it, just ask to continue
            messages.append({"role": "user", "content": "Continue the story from where it left off."})

        return messages

    def _build_story_context(self, segments: List[StorySegment], max_tokens: int) -> str:
        if not segments:
            return ""
            
        # Filter out original segments that have already been folded into a summary segment
        active_segments = [s for s in segments if not getattr(s, 'is_summarized', False)]
        
        if not active_segments:
            return ""
        
        # Prepare parts with summary annotations if needed
        context_parts = []
        if len(active_segments) > self.summary_threshold:
            for seg in active_segments[:-self.summary_threshold]:
                if seg.is_summary:
                    context_parts.append(f"[Summary] {seg.content}")
                else:
                    context_parts.append(seg.content)
            for seg in active_segments[-self.summary_threshold:]:
                if seg.is_summary:
                    context_parts.append(f"[Summary] {seg.content}")
                else:
                    context_parts.append(seg.content)
        else:
            for seg in active_segments:
                if seg.is_summary:
                    context_parts.append(f"[Summary] {seg.content}")
                else:
                    context_parts.append(seg.content)
                    
        # Truncate oldest segments to fit within max_tokens (keep the most recent)
        final_parts = []
        current_tokens = 0
        for part in reversed(context_parts):
            part_tokens = len(part) // 4
            if current_tokens + part_tokens > max_tokens and final_parts:
                break
            final_parts.insert(0, part)
            current_tokens += part_tokens

        return "\n\n".join(final_parts)

    def should_summarize(self, segments: List[StorySegment]) -> bool:
        # Only count segments that are not summaries and haven't been summarized yet
        non_summary = [s for s in segments if not s.is_summary and not getattr(s, 'is_summarized', False)]
        return len(non_summary) > self.summary_threshold

    def get_segments_to_summarize(self, segments: List[StorySegment]) -> List[StorySegment]:
        non_summary = [s for s in segments if not s.is_summary and not getattr(s, 'is_summarized', False)]
        # Summarize the oldest half of non-summary segments
        to_summarize_count = len(non_summary) - self.summary_threshold // 2
        return non_summary[:to_summarize_count]
