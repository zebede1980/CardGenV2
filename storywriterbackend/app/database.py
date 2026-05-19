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

        # character_cards.updated_at (back-fill from created_at for existing rows)
        if not _column_exists(conn, "character_cards", "updated_at"):
            conn.execute(text(
                "ALTER TABLE character_cards ADD COLUMN updated_at TIMESTAMP"
            ))
            conn.execute(text(
                "UPDATE character_cards SET updated_at = created_at WHERE updated_at IS NULL"
            ))

def init_db():
    run_migrations()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
