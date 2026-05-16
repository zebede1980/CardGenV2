from sqlalchemy import text
from app.models import Base, engine, SessionLocal

def _column_exists(conn, table: str, column: str) -> bool:
    result = conn.execute(text(f"PRAGMA table_info({table})"))
    return any(row[1] == column for row in result)

def _table_exists(conn, table: str) -> bool:
    result = conn.execute(text(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=:t"
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
                "VALUES ('admin', 'CHANGE_PASSWORD', datetime('now'))"
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

def init_db():
    run_migrations()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
