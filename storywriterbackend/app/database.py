from sqlalchemy import text
from app.models import Base, engine, SessionLocal

def _column_exists(conn, table: str, column: str) -> bool:
    result = conn.execute(text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = :t AND column_name = :c"
    ), {"t": table, "c": column})
    return result.fetchone() is not None

def _table_exists(conn, table: str) -> bool:
    result = conn.execute(text(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_name = :t"
    ), {"t": table})
    return result.fetchone() is not None

def run_migrations():
    """Apply schema migrations to an existing database without data loss."""
    with engine.begin() as conn:
        # Create any brand-new tables (users, steering_instructions, etc.)
        Base.metadata.create_all(bind=engine)

        # Ensure a default user exists (id=1) so pre-existing rows can be assigned
        result = conn.execute(text("SELECT COUNT(*) FROM users"))
        if result.scalar() == 0:
            conn.execute(text(
                "INSERT INTO users (username, password, created_at) "
                "VALUES ('admin', 'CHANGE_PASSWORD', NOW())"
            ))

        default_user_id = conn.execute(text("SELECT id FROM users ORDER BY id LIMIT 1")).scalar()

        # character_cards.user_id
        if not _column_exists(conn, "character_cards", "user_id"):
            conn.execute(text(
                f"ALTER TABLE character_cards ADD COLUMN user_id INTEGER NOT NULL DEFAULT {default_user_id}"
            ))

        # stories.user_id
        if not _column_exists(conn, "stories", "user_id"):
            conn.execute(text(
                f"ALTER TABLE stories ADD COLUMN user_id INTEGER NOT NULL DEFAULT {default_user_id}"
            ))

        # settings.user_id
        if not _column_exists(conn, "settings", "user_id"):
            conn.execute(text(
                f"ALTER TABLE settings ADD COLUMN user_id INTEGER NOT NULL DEFAULT {default_user_id}"
            ))

        # settings.system_prompt
        if not _column_exists(conn, "settings", "system_prompt"):
            conn.execute(text(
                "ALTER TABLE settings ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''"
            ))

        # settings.image_model
        if not _column_exists(conn, "settings", "image_model"):
            conn.execute(text(
                "ALTER TABLE settings ADD COLUMN image_model TEXT NOT NULL DEFAULT ''"
            ))

        # TTS settings columns
        if not _column_exists(conn, "settings", "tts_enabled"):
            conn.execute(text(
                "ALTER TABLE settings ADD COLUMN tts_enabled BOOLEAN NOT NULL DEFAULT false"
            ))
        if not _column_exists(conn, "settings", "tts_voice"):
            conn.execute(text(
                "ALTER TABLE settings ADD COLUMN tts_voice TEXT NOT NULL DEFAULT 'p230'"
            ))
        if not _column_exists(conn, "settings", "tts_model"):
            conn.execute(text(
                "ALTER TABLE settings ADD COLUMN tts_model TEXT NOT NULL DEFAULT 'tts_models/en/vctk/vits'"
            ))
        if not _column_exists(conn, "settings", "tts_speed"):
            conn.execute(text(
                "ALTER TABLE settings ADD COLUMN tts_speed FLOAT NOT NULL DEFAULT 1.0"
            ))
        if not _column_exists(conn, "settings", "auto_mode"):
            conn.execute(text(
                "ALTER TABLE settings ADD COLUMN auto_mode BOOLEAN NOT NULL DEFAULT false"
            ))

        # character_cards.updated_at (back-fill from created_at for existing rows)
        if not _column_exists(conn, "character_cards", "updated_at"):
            conn.execute(text(
                "ALTER TABLE character_cards ADD COLUMN updated_at TIMESTAMP"
            ))
            conn.execute(text(
                "UPDATE character_cards SET updated_at = created_at WHERE updated_at IS NULL"
            ))

        # roleplay_chats user persona fields
        if not _column_exists(conn, "roleplay_chats", "user_persona_name"):
            conn.execute(text("ALTER TABLE roleplay_chats ADD COLUMN user_persona_name VARCHAR NOT NULL DEFAULT 'User'"))
        if not _column_exists(conn, "roleplay_chats", "user_persona_age"):
            conn.execute(text("ALTER TABLE roleplay_chats ADD COLUMN user_persona_age VARCHAR NOT NULL DEFAULT ''"))
        if not _column_exists(conn, "roleplay_chats", "user_persona_gender"):
            conn.execute(text("ALTER TABLE roleplay_chats ADD COLUMN user_persona_gender VARCHAR NOT NULL DEFAULT ''"))
        if not _column_exists(conn, "roleplay_chats", "user_persona_detail"):
            conn.execute(text("ALTER TABLE roleplay_chats ADD COLUMN user_persona_detail TEXT NOT NULL DEFAULT ''"))
        if not _column_exists(conn, "roleplay_chats", "user_persona_card_id"):
            conn.execute(text("ALTER TABLE roleplay_chats ADD COLUMN user_persona_card_id INTEGER"))

        # adventure_sessions system prompt
        if not _column_exists(conn, "adventure_sessions", "system_prompt"):
            conn.execute(text("ALTER TABLE adventure_sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''"))

        # chat_messages new fields
        if not _column_exists(conn, "chat_messages", "avatar_url"):
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN avatar_url VARCHAR"))
        if not _column_exists(conn, "chat_messages", "character_name"):
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN character_name VARCHAR"))
        if not _column_exists(conn, "chat_messages", "is_summarized"):
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN is_summarized BOOLEAN NOT NULL DEFAULT false"))
        if not _column_exists(conn, "chat_messages", "is_extracted"):
            conn.execute(text("ALTER TABLE chat_messages ADD COLUMN is_extracted BOOLEAN NOT NULL DEFAULT false"))

        # story_segments new fields
        if not _column_exists(conn, "story_segments", "is_summarized"):
            conn.execute(text("ALTER TABLE story_segments ADD COLUMN is_summarized BOOLEAN NOT NULL DEFAULT false"))

def init_db():
    run_migrations()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
