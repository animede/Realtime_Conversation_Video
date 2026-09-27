"""OpenAI互換LLMクライアント(gemma4-E4B想定)。

音声はASRを介さず input_audio (base64 WAV) としてそのまま渡す。
文字起こしは履歴・画面表示用に別呼び出しで並列に行う(AI-chara方式)。
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from .config import settings

# AI-chara bootstrap.py の実績プロンプトを踏襲
TRANSCRIPTION_SYSTEM_INSTRUCTION = (
    "あなたは音声入力を文字化する補助役です。"
    "ユーザーが話した内容だけを日本語で返してください。"
    "前置き、説明、返答は禁止です。"
)
TRANSCRIPTION_USER_INSTRUCTION = "この音声で話している内容を文字にしてください。"


class LLMClient:
    def __init__(self) -> None:
        self._model: str | None = settings.llm_model or None

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if settings.llm_api_key:
            headers["Authorization"] = f"Bearer {settings.llm_api_key}"
        return headers

    async def resolve_model(self) -> str:
        if self._model:
            return self._model
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{settings.llm_base_url}/models", headers=self._headers()
            )
            response.raise_for_status()
            body = response.json()
        # OpenAI形式 {"data":[{"id":...}]} と llama.cpp独自 {"models":[{"name":...}]} の両対応
        entries = body.get("data") or body.get("models") or []
        if not entries:
            raise RuntimeError("LLMサーバにモデルがありません")
        self._model = entries[0].get("id") or entries[0].get("name")
        return self._model

    async def stream_reply(self, messages: list[dict]) -> AsyncIterator[str]:
        """chat/completions をストリーミングし、テキスト差分を逐次返す。"""
        payload = {
            "model": await self.resolve_model(),
            "messages": messages,
            "stream": True,
            "max_tokens": settings.reply_max_tokens,
            "temperature": settings.reply_temperature,
        }
        timeout = httpx.Timeout(settings.llm_timeout_seconds, connect=10)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", f"{settings.llm_base_url}/chat/completions",
                json=payload, headers=self._headers(),
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        delta = json.loads(data)["choices"][0]["delta"].get("content")
                    except (KeyError, IndexError, ValueError):
                        continue
                    if delta:
                        yield delta

    async def _complete(self, messages: list[dict], *, max_tokens: int,
                        temperature: float) -> str:
        payload = {
            "model": await self.resolve_model(),
            "messages": messages,
            "stream": False,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        timeout = httpx.Timeout(settings.llm_timeout_seconds, connect=10)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{settings.llm_base_url}/chat/completions",
                json=payload, headers=self._headers(),
            )
            response.raise_for_status()
            return str(response.json()["choices"][0]["message"]["content"]).strip()

    async def transcribe(self, audio_b64: str, audio_format: str = "wav") -> str | None:
        """履歴・表示用の文字起こし。失敗したらNone(会話は音声直入力で継続する)。"""
        messages = [
            {"role": "system", "content": TRANSCRIPTION_SYSTEM_INSTRUCTION},
            {"role": "user", "content": [
                {"type": "text", "text": TRANSCRIPTION_USER_INSTRUCTION},
                {"type": "input_audio",
                 "input_audio": {"data": audio_b64, "format": audio_format}},
            ]},
        ]
        try:
            text = await self._complete(messages, max_tokens=160, temperature=0.0)
        except (httpx.HTTPError, KeyError, IndexError, ValueError):
            return None
        # プロンプト漏れの検出(AI-charaの教訓)
        leaks = ("聞き取れた発話", "文字化する補助役", "前置き、説明、返答は禁止")
        if not text or any(fragment in text for fragment in leaks):
            return None
        return text

    async def summarize(self, text: str) -> str | None:
        """長い返答を履歴用に圧縮する(use_summary_for_history方式)。"""
        messages = [
            {"role": "system", "content": (
                f"次の発言の要点を{settings.summary_max_chars}文字以内の日本語で要約してください。"
                "要約文だけを返してください。"
            )},
            {"role": "user", "content": text},
        ]
        try:
            summary = await self._complete(messages, max_tokens=160, temperature=0.2)
        except (httpx.HTTPError, KeyError, IndexError, ValueError):
            return None
        return summary or None


llm = LLMClient()
