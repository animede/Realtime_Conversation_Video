# Realtime Conversation Video

[English](README.en.md) | 日本語

**マイクに話しかけると、キャラクターが声と映像でリアルタイムに答える** — [Realtime_Narration_Video](https://github.com/animede/Realtime_Narration_Video)(r-n-v)をヘッドレスのキャラクターレンダリングサービスとして使う、音声会話クライアントです。

r-n-v で登録したキャラクターとの会話に特化した薄いアプリです。動画生成・TTS・プリセットは r-n-v 側に任せ、会話の頭脳(ROLE 注入・マイク音声入力・履歴のローリング要約)をこちらが持ちます。

## 動作サンプル（実時間・50秒）



https://github.com/user-attachments/assets/b7af6e12-372f-4191-9721-82ea52ecd525



マイクとテキストでキャラクターと会話する様子を、編集なしの実時間で収録したものです。応答チャンクは再生より速く生成されるため、会話は途切れずに続きます。クリックで[MP4版（6.4MB）](docs/assets/demo-conversation.mp4)を開きます。

## 構成

```
ブラウザ ──(マイクVAD/テキスト)──> Realtime Conversation Video (8791)
   │                                  │  OpenAI互換 LLM (gemma4-E4B, input_audio対応)
   │                                  │  返答確定後 POST /narrations (LLMバイパス)
   └──(プリセット復元/SSE/MP4)──> realtime-narration-video (8782)
```

- **音声入力**: ブラウザ側 VAD(energy+ZCR、BPF 250-4000Hz、無音900msで区切り)。
  区切った WAV を base64 でそのまま LLM の `input_audio` に渡す(ASR 不要)。
  文字起こしは表示・履歴用に並列で行う(返答を待たせない)。
- **ROLE**: SYSTEM プロンプトに追記。preset ごとにブラウザの localStorage へ保存
  (ターン送信前に自動でサーバへ同期される)。
- **話者ID**: r-n-v の `PATCH /api/sessions/{id}/settings` で反映。
- **履歴**: 直近4ターン+古いターンはローリング要約。長い返答は要約版を履歴に使う。

これらの設計判断の理由(ASRを返答経路から外す構造、KVキャッシュを守る運用設計、初回応答のレイテンシ予算)は [docs/conversation-pipeline.md](docs/conversation-pipeline.md) で解説しています。

## 起動

前提サービス: gateway(8630) → TTS(10101) → r-n-v(8782)。
r-n-v は CORS 対応版(2026-09-17 以降の master)であること。

```bash
./run.sh          # http://localhost:8791
```

## 環境変数

| 変数 | 既定値 | 意味 |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:8000/v1` | OpenAI互換LLM(音声入力を使う場合は `input_audio` 対応モデル) |
| `LLM_MODEL` | (自動: /models の先頭) | モデル名 |
| `LLM_API_KEY` | (なし) | Bearer トークン |
| `NARRATION_URL` | `http://localhost:8782` | r-n-v のURL |
| `NARRATION_PUBLIC_URL` | = NARRATION_URL | ブラウザから見た r-n-v のURL |
| `MAX_HISTORY` | 4 | 保持ターン数 |
| `SUMMARY_THRESHOLD_CHARS` | 150 | これを超えた返答は履歴に要約版を使う |

## 前提サービスとエコシステム

本アプリは以下のスタックの最上段に載る会話クライアントです(下から順に起動):

1. [diffusers-movie-server](https://github.com/animede/diffusers-movie-server) gateway(8630)— LTX-2.5 バックエンド管理
2. AivisSpeech Engine(10101)— TTS
3. [Realtime_Narration_Video](https://github.com/animede/Realtime_Narration_Video)(8782)— キャラクターレンダリング(2026-09-17 以降の CORS 対応版)
4. 本アプリ(8791)

LTX-2.5 の高速化・低VRAM化の技術詳細は [diffusers-ltx2_5](https://github.com/animede/diffusers-ltx2_5) の docs を参照してください。r-n-v の 32GB 級構成(`nvfp4-32gb`)でもそのまま動作します。

## ライセンス

このリポジトリ内のアプリケーションコードは [Apache License 2.0](LICENSE) で公開しています。

依存モジュール、外部サービス、モデル、ウェイト(LTX-2.5、Gemma、AivisSpeech 等)は本ライセンスの対象に含まれません。それぞれの提供元が定めるライセンス・利用規約に従ってください。本リポジトリにはモデルおよびモデルウェイトを同梱していません。
