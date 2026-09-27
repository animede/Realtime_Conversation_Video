# Realtime Conversation Video

English | [日本語](README.md)

**Speak into the mic, and the character answers back in real time — with voice and video.** A voice-first conversation client that uses [Realtime_Narration_Video](https://github.com/animede/Realtime_Narration_Video) (r-n-v) as a headless character-rendering service.

This is a thin app specialized for conversation with characters registered in r-n-v. Video generation, TTS, and presets stay on the r-n-v side; the conversational brain — ROLE injection, microphone input, rolling history summarization — lives here.

## Architecture

```
Browser ──(mic VAD / text)──> Realtime Conversation Video (8791)
   │                              │  OpenAI-compatible LLM (audio-input capable)
   │                              │  after the reply settles: POST /narrations (LLM bypass)
   └──(preset restore / SSE / MP4)──> Realtime_Narration_Video (8782)
```

- **Voice input**: browser-side VAD (energy + ZCR, 250–4000 Hz band-pass, 900 ms silence cut). Segmented WAV goes straight to the LLM as `input_audio` — no ASR sits in the reply path (transcription runs in parallel, for display and history only).
- **ROLE**: appended to the SYSTEM prompt; stored per preset in the browser's localStorage and synced to the server before each turn.
- **History**: last 4 turns kept verbatim; older turns roll up into a running summary. Long replies enter history as summaries.

## Running

Prerequisite stack, bottom-up: [diffusers-movie-server](https://github.com/animede/diffusers-movie-server) gateway (8630) → AivisSpeech Engine TTS (10101) → [Realtime_Narration_Video](https://github.com/animede/Realtime_Narration_Video) (8782, a CORS-enabled build from 2026-09-17 or later).

```bash
./run.sh          # http://localhost:8791
```

Configure via `.env` (see `.env.example`): `LLM_BASE_URL` (OpenAI-compatible; an `input_audio`-capable model is required for voice input), `NARRATION_URL`, and history/summary knobs.

For the acceleration and low-VRAM engineering underneath (including the 32 GB-class `nvfp4-32gb` configuration this app runs on unchanged), see the docs in [diffusers-ltx2_5](https://github.com/animede/diffusers-ltx2_5).

## License

Application code in this repository is released under the [Apache License 2.0](LICENSE).

Dependencies, external services, models, and weights (LTX-2.5, Gemma, AivisSpeech, etc.) are not covered by this license; follow each provider's own license and terms. No model weights are included in this repository.
