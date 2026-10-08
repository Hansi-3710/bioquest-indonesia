"""Configuration. Secrets come from environment variables / .env, never from code."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MB = 1024 * 1024


def load_dotenv(path=None):
    path = Path(path or BASE_DIR / ".env")
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def build_config(overrides=None):
    load_dotenv()
    production = os.environ.get("BIOQUEST_ENV", "development") == "production"
    data_dir = Path(os.environ.get("BIOQUEST_DATA_DIR", BASE_DIR / "data"))
    cfg = {
        "PRODUCTION": production,
        "SECRET_KEY": os.environ.get("SECRET_KEY"),
        "MASTER_KEY": os.environ.get("MASTER_KEY"),
        "DATA_DIR": str(data_dir),
        "DB_PATH": str(data_dir / "bioquest.db"),
        "UPLOAD_DIR": str(data_dir / "uploads"),
        "MAX_CONTENT_LENGTH": 45 * MB,
        "MAX_IMAGE_BYTES": 12 * MB,
        "MAX_VIDEO_BYTES": 40 * MB,
        "TRUSTED_PROXIES": int(os.environ.get("TRUSTED_PROXIES", "0")),
        "SESSION_COOKIE_NAME": "__Host-bq" if production else "bq_session",
        "SESSION_COOKIE_HTTPONLY": True,
        "SESSION_COOKIE_SAMESITE": "Lax",
        "SESSION_COOKIE_SECURE": production,
        "TRAINING_TARGET_PER_SPECIES": 50,
    }
    cfg.update(overrides or {})
    return cfg
