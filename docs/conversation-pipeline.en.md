# Conversation Pipeline Explained

This document explains *why* the conversation pipeline is shaped the way it is. What runs is covered in the [README](../README.en.md); the character-rendering side is covered in the [Realtime_Narration_Video technical guide](https://github.com/animede/Realtime_Narration_Video/blob/master/docs/technical-guide.en.md). This document focuses on the design decisions.

## 1. Overall picture and division of roles

```
Browser                 Realtime Conversation Video          External
┌──────────────┐        ┌──────────────────────────┐
│ Mic → VAD    │──WAV──>│ Conversational brain:     │──chat──> LLM server
│ Text input   │──text─>│  ROLE injection, history, │  (OpenAI-compatible,
│ SSE stream   │<──SSE──│  folding, streaming       │   input_audio capable)
└──────┬───────┘        │  After the reply settles: │
       │                │  POST /narrations         │──text──> r-n-v (8782)
       └────video/audio──────────────────────────────────────┘  TTS + video
```

The conversational brain (ROLE, history, summarization, LLM calls) lives in this app; voice and video (TTS, video chunk generation, presets) live in r-n-v. The boundary is a single point: handing over the reply text. This separation means improvements on the conversation side never ripple into the rendering side, and vice versa.

## 2. Taking ASR out of the reply path

The conventional voice-input pipeline is a serial "ASR → text → LLM". This app does not do that: the WAV segmented by the VAD goes **straight to the LLM** as `input_audio` ([main.py](../app/main.py), audio-turn).

There are two reasons. First, latency: a serial ASR makes the reply wait for transcription to finish before it can even start. Second, quality: an ASR misrecognition becomes final the moment it turns into text, and the LLM can only respond to the wrong text. An LLM that hears the audio directly can resolve ambiguous speech from context, and prosody is not lost.

Transcription still happens — but **only for display and history, in parallel with the reply stream** ([llm.py](../app/llm.py), `transcribe`). On failure it just returns `None` and the conversation continues on direct audio input. Transcription is auxiliary information, not a dependency.

## 3. Browser-side VAD

Speech segmentation happens entirely in the browser ([mic.js](../static/mic.js)): a hybrid energy (RMS) + ZCR decision, a 250–4000 Hz band-pass front end, a 900 ms silence cut, fragments under 260 ms discarded, six pre-roll frames, output as WAV (PCM16 mono).

We avoided server-side VAD because it requires streaming audio to the server continuously just to make the decision. With the decision made in the browser, only confirmed speech segments ever touch the network, and silent periods generate zero traffic.

## 4. Turn progression

Each conversation processes one turn at a time (busy gate; a send while one is in flight gets 409). Within a turn the concurrency structure is:

- LLM streaming reception → each delta immediately to the browser over SSE (`reply_delta`)
- Transcription of the user's utterance (audio turns only) → **the entire WAV of the user's speech for that turn**, as segmented from the mic input by the VAD, goes to a separate one-shot LLM call; SSE (`user_text`) as soon as it completes. It never touches the reply stream (this app has no cut-sentences-from-the-stream processing — that mechanism belongs to r-n-v's own chat mode)
- After the reply settles → history commit, background summarization for long replies (`summarize_later`), handoff to r-n-v

Every failure reaches the user with a reason via the SSE `error` event. Not dying silently in the background is a priority.

## 5. History retention and folding

History has three tiers ([conversation.py](../app/conversation.py)):

1. **Recent turns verbatim** (`MAX_HISTORY`, default 4 turns)
2. **Overflowing old turns fold into a rolling summary mechanically** ("User: …" / "Chara: …" lines clipped to 80 chars — no LLM involved)
3. **Only long replies get an LLM summary swapped in** (only above `SUMMARY_THRESHOLD_CHARS`; generated in the background, takes effect from the next turn)

Folding is **batched** rather than per-turn (`HISTORY_FOLD_BATCH_TURNS`, default: fold once 3 turns have accumulated). The reason is the KV cache, covered next.

Not using an LLM for the rolling summary is deliberate. At this history scale, mechanical clipping preserves context well enough — and making LLM summarization zero removes both a cache-pollution source and an off-hot-path failure mode in one stroke.

## 6. Designing to protect the KV cache

As a conversation grows, the LLM's time-to-first-token becomes dominated by prompt evaluation (prefill). A prefix cache lets the server reuse the evaluation of everything already seen — but **whether it actually hits is decided by operational design**. This app is built around the following principle.

**Principle: the boundary of a cache domain is the server process.** The KV cache exists per server process. Send any non-conversation request (a summary, for example) to the same server, and the conversation prefix gets evicted from its slot — the next turn pays a full re-prefill. The key distinction is that **compute contention and cache eviction are different kinds of degradation**: contention is a transient cost that exists only while requests overlap, while eviction is a persistent cost that hits every subsequent turn. Whether to split GPUs is a contention question; what cache protection requires is splitting *processes*. On a powerful GPU you can run two model servers on one card, separated only by port, and cache isolation is complete.

The principle is applied here as follows:

- **The rolling summary never calls an LLM** (previous section). Folding has no opportunity to touch the cache at all
- **Batched folding.** The summary lives inside the system message, so every fold invalidates the prefix from the summary onward. Batching makes that happen once every N turns; in between, history is append-only — a fully stable prefix (measured: system changes in a 20-turn conversation went from 16 with per-turn folding to 5)
- **The head of the system message is immutable.** The base instruction + ROLE sit at the front and stay byte-identical throughout the conversation; the summary is placed after them
- **The rendering side never touches the conversation server.** The handoff to r-n-v uses the narration (LLM-bypass) endpoint, so the video/TTS side issues no LLM requests whatsoever
- **Two honest exceptions remain.** When a long reply's summary is swapped into history, one message changes and the cache breaks once from that position (the design assumes pairing with a prompt instruction to keep replies short). And transcription plus long-reply summarization go to the same server as the conversation by default — a thin-client trade-off; transcription needs an `input_audio`-capable model so it effectively co-resides, but moving summarization to a separate server process would make the cache domains fully disjoint

## 7. Handing off to video

The reply text is posted to r-n-v's narration endpoint (`POST /api/sessions/{id}/narrations`) **after it settles**. Sentence-level TTS, audio/chunk assembly, and pipelined video generation are r-n-v's job. If the previous turn's generation has not finished, the endpoint returns 409, so the app retries at 1-second intervals up to 30 times.

Not streaming sentence-by-sentence into r-n-v during the LLM stream is a deliberate trade to keep the boundary at a single point of settled text. Since replies are instructed to be short, the cost of waiting for settlement stays small.

## 8. The first-response latency budget

"From when you stop speaking to when the character starts speaking" is the sum of three segments:

1. **Speech finalization**: 900 ms of silence (the VAD's cut decision — shorter and it would cut on mid-utterance breaths)
2. **Reply generation**: LLM streaming, kept short by prompt instruction, with prefill held down by the cache design above
3. **First video and audio**: r-n-v generates only the turn's first chunk at reduced resolution and steps, delivering first motion in about 2.6 seconds; subsequent chunks generate behind playback and are never seen. See [r-n-v technical guide §7.1](https://github.com/animede/Realtime_Narration_Video/blob/master/docs/technical-guide.en.md#71-low-resolution-first-chunk-the-lever-that-sets-conversational-responsiveness)

Generation time for every chunk after the first hides behind playback, so these three segments are all that perceived latency consists of — and each has its own independent lever (the VAD silence threshold / reply-length instruction and cache design / first-chunk resolution).
