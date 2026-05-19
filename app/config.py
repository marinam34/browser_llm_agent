from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _read_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    openrouter_api_key: str | None
    openrouter_model: str
    openrouter_base_url: str
    openrouter_referer: str
    openrouter_app_title: str
    host: str
    port: int
    browser_headless: bool
    browser_engine: str
    browser_slow_mo_ms: int
    browser_locale: str
    navigation_timeout_ms: int
    max_actions_per_turn: int
    max_planning_cycles: int
    allow_final_actions: bool


def load_settings() -> Settings:
    return Settings(
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY"),
        openrouter_model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4.1-mini"),
        openrouter_base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        openrouter_referer=os.getenv("OPENROUTER_REFERER", "http://127.0.0.1:8000"),
        openrouter_app_title=os.getenv("OPENROUTER_APP_TITLE", "universal-llm-agent"),
        host=os.getenv("HOST", "127.0.0.1"),
        port=_read_int("PORT", 8000),
        browser_headless=_read_bool("BROWSER_HEADLESS", False),
        browser_engine=os.getenv("BROWSER_ENGINE", "chromium"),
        browser_slow_mo_ms=_read_int("BROWSER_SLOW_MO_MS", 80),
        browser_locale=os.getenv("BROWSER_LOCALE", "ru-RU"),
        navigation_timeout_ms=_read_int("NAVIGATION_TIMEOUT_MS", 30000),
        max_actions_per_turn=_read_int("MAX_ACTIONS_PER_TURN", 6),
        max_planning_cycles=_read_int("MAX_PLANNING_CYCLES", 3),
        allow_final_actions=_read_bool("ALLOW_FINAL_ACTIONS", False),
    )


settings = load_settings()
