"""会話状態とプロンプト組み立て(AI-chara HOT-PATHの簡略版)。

- 直近 max_history ターンをそのまま保持
- あふれた古いターンはローリング要約(文字列)に畳んで system で渡す
- 閾値超の assistant 返答は要約版を履歴に使う(元文はUI表示済みなので失わない)
- ROLE の永続化はブラウザ側(localStorage、presetごと)。サーバは会話中の値だけ持つ
"""
from __future__ import annotations

from dataclasses import dataclass, field
from time import time
from uuid import uuid4

from .config import settings

BASE_SYSTEM_INSTRUCTION = (
    "あなたは会話中のAIキャラクタです。"
    "直前の会話入力(音声のときもあります)に対して、日本語の話し言葉で自然に返答してください。"
    "返答はそのまま音声合成されるので、Markdown・URL・記号列・箇条書きは使わないでください。"
)


@dataclass
class Turn:
    role: str                     # "user" | "assistant"
    content: str
    summary: str | None = None    # 履歴用の要約(長い返答のみ)

    def for_history(self) -> str:
        if self.role == "assistant" and self.summary and \
                len(self.content) > settings.summary_threshold_chars:
            return self.summary
        return self.content


@dataclass
class Conversation:
    preset_id: str
    rnv_session_id: str
    role: str = ""
    id: str = field(default_factory=lambda: uuid4().hex)
    turns: list[Turn] = field(default_factory=list)
    rolling_summary: str = ""
    busy: bool = False
    created_at: float = field(default_factory=time)

    def system_prompt(self) -> str:
        parts = [BASE_SYSTEM_INSTRUCTION]
        if self.role.strip():
            parts.append("あなたの役割・キャラクタ設定:\n" + self.role.strip())
        if self.rolling_summary:
            parts.append("これまでの会話の要約:\n" + self.rolling_summary)
        return "\n\n".join(parts)

    def build_messages(self, user_content: str | list) -> list[dict]:
        # turns は畳み込み済みの保持分のみ(バッチ畳み込み中は max_history+batch まで
        # 伸びる)。全件載せないと「要約前なのにプロンプトから消える」欠落が起きる
        messages: list[dict] = [{"role": "system", "content": self.system_prompt()}]
        for turn in self.turns:
            messages.append({"role": turn.role, "content": turn.for_history()})
        messages.append({"role": "user", "content": user_content})
        return messages

    def append_turn(self, user_text: str, assistant_text: str) -> Turn:
        """ターン確定。あふれた古いターンはローリング要約に畳む。

        畳み込みはバッチ化(history_fold_batch_turns)。毎ターン畳むと system 内の
        要約が毎ターン変わり、LLMサーバのプレフィックスKVキャッシュが要約位置から
        先で毎回割れる。超過をためて N ターンに1回まとめて畳むことで、間のターンは
        履歴が追記のみ(=プレフィックス安定)になり、再prefillが償却される。
        履歴は一時的に max_history+batch ターンまで伸びるが、回答長は
        summary_threshold_chars とプロンプト指示で抑えられており実害は小さい。

        返り値は assistant の Turn(後から summary を差し込むため)。
        """
        self.turns.append(Turn(role="user", content=user_text))
        assistant = Turn(role="assistant", content=assistant_text)
        self.turns.append(assistant)
        overflow = len(self.turns) - settings.max_history * 2
        if overflow >= max(1, settings.history_fold_batch_turns) * 2:
            dropped, self.turns = self.turns[:overflow], self.turns[overflow:]
            lines = [self.rolling_summary] if self.rolling_summary else []
            labels = {"user": "ユーザー", "assistant": "キャラ"}
            for turn in dropped:
                text = turn.for_history().replace("\n", " ")
                if len(text) > 80:
                    text = text[:80] + "…"
                lines.append(f"{labels[turn.role]}: {text}")
            summary = "\n".join(lines)
            # 直近が残るよう先頭(古い側)から切り詰める
            if len(summary) > settings.rolling_summary_max_chars:
                summary = summary[-settings.rolling_summary_max_chars:]
                summary = summary.split("\n", 1)[-1]
            self.rolling_summary = summary
        return assistant
