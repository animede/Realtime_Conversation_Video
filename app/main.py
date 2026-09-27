from __future__ import annotations

import asyncio
import base64
import binascii
import json
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import settings
from .conversation import Conversation
from .llm import llm

app = FastAPI(title="Realtime Conversation Video", version="0.1.0")
static_dir = Path(__file__).parent.parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.middleware("http")
async def no_stale_static(request, call_next):
    """静的ファイルは毎回再検証させる(ETagで304になるだけなので軽い)。

    既定のヒューリスティックキャッシュだと、修正後も古いJS/CSSで動き続けて
    「直したはずが直っていない」が起きる(2026-09-17に実際に発生)。
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response

conversations: dict[str, Conversation] = {}
subscribers: dict[str, list[asyncio.Queue]] = {}


def broadcast(conversation_id: str, event: dict) -> None:
    for queue in subscribers.get(conversation_id, []):
        queue.put_nowait(event)


@app.get("/")
async def index():
    return FileResponse(static_dir / "index.html")


@app.get("/api/config")
async def config():
    return {"narration_url": settings.public_narration_url}


class ConversationCreate(BaseModel):
    preset_id: str
    rnv_session_id: str
    role: str = ""
    voice_id: int | None = None


class ConversationUpdate(BaseModel):
    role: str | None = None
    voice_id: int | None = None


class TextTurn(BaseModel):
    text: str


class AudioTurn(BaseModel):
    audio_b64: str
    format: str = "wav"


def get_conversation_or_404(conversation_id: str) -> Conversation:
    conversation = conversations.get(conversation_id)
    if conversation is None:
        raise HTTPException(404, "会話が見つかりません")
    return conversation


async def patch_voice_id(rnv_session_id: str, voice_id: int) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.patch(
            f"{settings.narration_url}/api/sessions/{rnv_session_id}/settings",
            json={"voice_id": voice_id},
        )
        if not response.is_success:
            raise HTTPException(502, f"話者IDの反映に失敗しました: HTTP {response.status_code}")


@app.post("/api/conversations")
async def create_conversation(request: ConversationCreate):
    if len(request.role) > 4_000:
        raise HTTPException(400, "ROLEは4,000文字以内にしてください")
    conversation = Conversation(
        preset_id=request.preset_id,
        rnv_session_id=request.rnv_session_id,
        role=request.role,
    )
    if request.voice_id is not None:
        await patch_voice_id(request.rnv_session_id, request.voice_id)
    conversations[conversation.id] = conversation
    return {"id": conversation.id}


@app.patch("/api/conversations/{conversation_id}")
async def update_conversation(conversation_id: str, request: ConversationUpdate):
    conversation = get_conversation_or_404(conversation_id)
    if request.role is not None:
        if len(request.role) > 4_000:
            raise HTTPException(400, "ROLEは4,000文字以内にしてください")
        conversation.role = request.role
    if request.voice_id is not None:
        await patch_voice_id(conversation.rnv_session_id, request.voice_id)
    return {"ok": True}


async def post_narration(conversation: Conversation, text: str) -> None:
    """返答をr-n-vの朗読(LLMバイパス)経路へ投入する。

    直前ターンの生成が終わっていないと409が返るので、少し待って粘る。
    """
    url = f"{settings.narration_url}/api/sessions/{conversation.rnv_session_id}/narrations"
    async with httpx.AsyncClient(timeout=15) as client:
        for _ in range(30):
            response = await client.post(url, json={"text": text})
            if response.status_code != 409:
                break
            await asyncio.sleep(1.0)
    if response.is_success:
        broadcast(conversation.id, {"type": "narration_posted"})
    else:
        detail = response.text[:200]
        broadcast(conversation.id, {
            "type": "error",
            "message": f"キャラ映像への投入に失敗しました (HTTP {response.status_code}): {detail}",
        })


async def summarize_later(conversation: Conversation, turn) -> None:
    """長い返答の履歴用要約を裏で作る(次ターンのプロンプトから効く)。"""
    if len(turn.content) <= settings.summary_threshold_chars:
        return
    turn.summary = await llm.summarize(turn.content)


async def run_turn(conversation: Conversation, user_content: str | list,
                   transcript_task: asyncio.Task | None,
                   user_text_hint: str) -> None:
    try:
        user_text_holder = {"text": user_text_hint}
        emit_transcript: asyncio.Task | None = None
        if transcript_task is not None:
            async def _emit_transcript() -> None:
                transcript = await transcript_task
                if transcript:
                    user_text_holder["text"] = transcript
                broadcast(conversation.id,
                          {"type": "user_text", "text": user_text_holder["text"]})

            # 文字起こしは返答ストリームと並列。済み次第すぐUIへ流す。
            emit_transcript = asyncio.create_task(_emit_transcript())

        messages = conversation.build_messages(user_content)
        parts: list[str] = []
        async for delta in llm.stream_reply(messages):
            parts.append(delta)
            broadcast(conversation.id, {"type": "reply_delta", "text": delta})
        reply = "".join(parts).strip()

        if emit_transcript is not None:
            await emit_transcript
        user_text = user_text_holder["text"]

        if not reply:
            broadcast(conversation.id, {"type": "error", "message": "LLMの返答が空でした"})
            return
        broadcast(conversation.id, {"type": "reply_done", "text": reply})

        turn = conversation.append_turn(user_text, reply)
        asyncio.create_task(summarize_later(conversation, turn))
        await post_narration(conversation, reply)
    except Exception as exc:  # LLM/ネットワーク断でもUIに理由を返す
        broadcast(conversation.id, {"type": "error", "message": str(exc)})
    finally:
        conversation.busy = False
        broadcast(conversation.id, {"type": "turn_finished"})


def start_turn(conversation: Conversation, user_content: str | list,
               transcript_task: asyncio.Task | None, user_text_hint: str) -> None:
    if conversation.busy:
        if transcript_task is not None:
            transcript_task.cancel()
        raise HTTPException(409, "前の応答を生成中です")
    conversation.busy = True
    broadcast(conversation.id, {"type": "turn_started"})
    asyncio.create_task(
        run_turn(conversation, user_content, transcript_task, user_text_hint)
    )


@app.post("/api/conversations/{conversation_id}/text-turn", status_code=202)
async def text_turn(conversation_id: str, request: TextTurn):
    conversation = get_conversation_or_404(conversation_id)
    text = request.text.strip()
    if not text:
        raise HTTPException(400, "メッセージを入力してください")
    if len(text) > 8_000:
        raise HTTPException(400, "メッセージは8,000文字以内にしてください")
    start_turn(conversation, text, None, text)
    broadcast(conversation_id, {"type": "user_text", "text": text})
    return {"ok": True}


@app.post("/api/conversations/{conversation_id}/audio-turn", status_code=202)
async def audio_turn(conversation_id: str, request: AudioTurn):
    conversation = get_conversation_or_404(conversation_id)
    if len(request.audio_b64) > 20_000_000:
        raise HTTPException(400, "音声が大きすぎます")
    try:
        base64.b64decode(request.audio_b64[:4000], validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(400, "音声のデコードに失敗しました") from exc
    audio_format = request.format if request.format in {"wav", "mp3"} else "wav"
    # 返答は音声から直接生成(文字起こし待ちゼロ)。文字起こしは表示・履歴用に並列で走る。
    user_content = [
        {"type": "text", "text": "ユーザーがマイクで話しかけています。内容を聞き取って返答してください。"},
        {"type": "input_audio", "input_audio": {"data": request.audio_b64, "format": audio_format}},
    ]
    transcript_task = asyncio.create_task(llm.transcribe(request.audio_b64, audio_format))
    start_turn(conversation, user_content, transcript_task, "（音声入力）")
    return {"ok": True}


@app.get("/api/conversations/{conversation_id}/events")
async def conversation_events(conversation_id: str):
    get_conversation_or_404(conversation_id)

    async def events():
        queue: asyncio.Queue = asyncio.Queue()
        subscribers.setdefault(conversation_id, []).append(queue)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        finally:
            subscribers.get(conversation_id, []).remove(queue)

    return StreamingResponse(events(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
