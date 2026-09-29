from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    # 会話用LLM (OpenAI互換 /v1/chat/completions。音声入力を使う場合は
    # input_audio 対応モデル(例: Gemma系のオーディオ入力対応ビルド)が必要)
    llm_base_url: str = os.getenv("LLM_BASE_URL", "http://localhost:8000/v1").rstrip("/")
    llm_model: str = os.getenv("LLM_MODEL", "").strip()
    llm_api_key: str = os.getenv("LLM_API_KEY", "").strip()
    llm_timeout_seconds: float = float(os.getenv("LLM_TIMEOUT_SECONDS", "120"))

    # キャラクターレンダリングサービス (realtime-narration-video)
    narration_url: str = os.getenv("NARRATION_URL", "http://localhost:8782").rstrip("/")
    # ブラウザから見たr-n-vのURL(別ホストから開く場合に上書きする)
    narration_public_url: str = os.getenv("NARRATION_PUBLIC_URL", "").rstrip("/")

    # HOT-PATH lite(履歴・要約)
    max_history: int = int(os.getenv("MAX_HISTORY", "4"))
    summary_threshold_chars: int = int(os.getenv("SUMMARY_THRESHOLD_CHARS", "150"))
    summary_max_chars: int = int(os.getenv("SUMMARY_MAX_CHARS", "100"))
    rolling_summary_max_chars: int = int(os.getenv("ROLLING_SUMMARY_MAX_CHARS", "600"))
    # 畳み込みのバッチ化: 超過がこのターン数たまるまで要約に畳まない。
    # 畳むたびに system(要約) が変わりプレフィックスKVキャッシュが割れるため、
    # 毎ターンではなくNターンに1回へ償却する(間は履歴が追記のみ=キャッシュ有効)
    history_fold_batch_turns: int = int(os.getenv("HISTORY_FOLD_BATCH_TURNS", "3"))

    reply_max_tokens: int = int(os.getenv("REPLY_MAX_TOKENS", "400"))
    reply_temperature: float = float(os.getenv("REPLY_TEMPERATURE", "0.8"))

    data_dir: Path = Path(os.getenv("CHARA_CHAT_DATA", "./data")).resolve()

    @property
    def public_narration_url(self) -> str:
        return self.narration_public_url or self.narration_url


settings = Settings()
