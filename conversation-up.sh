#!/usr/bin/env bash
# 会話スタックをワンコマンドで起動する launcher。
#   ./conversation-up.sh          # 検査 → 構成自動決定 → 起動 → ブラウザ URL 表示
#   ./conversation-up.sh --doctor # 検査と構成の表示のみ(何も起動しない)
#
# ハードウェア(GPU 枚数・VRAM・RAM)から構成を自動決定し、
# gateway → H3 バックエンド → r-n-v(ヘッドレス)→ 本アプリ(r-c-v)の順に起動する。
# ユーザーが開く画面は r-c-v(会話画面)だけ。既に動いているサービスはそのまま使う
# (多重起動しない)。終了は ./conversation-down.sh(この script が起動した分だけ止める)。
#
# パス・URL は conversation.local.env で上書きできる(無ければ既定値)。
set -eu
cd "$(dirname "$0")"

# ---- 設定(conversation.local.env で上書き可) --------------------------------
MOVIE_SERVER_DIR="${MOVIE_SERVER_DIR:-$HOME/diffusers-movie-server}"
RNV_DIR="${RNV_DIR:-$HOME/realtime-narration-video}"
GATEWAY_PORT="${GATEWAY_PORT:-8630}"
RNV_PORT="${RNV_PORT:-8782}"
RCV_PORT="${RCV_PORT:-8791}"
TTS_URL="${TTS_URL:-http://localhost:10101}"
LLM_URL="${LLM_URL:-http://localhost:8000/v1}"
FORCE_PRESET="${FORCE_PRESET:-}"   # doctor の自動判定を上書きしたいときだけ指定
if [ -f conversation.local.env ]; then
  set -a; . ./conversation.local.env; set +a
fi

RUN_DIR=.conversation-run
mkdir -p "$RUN_DIR"

listening() { curl -sf -o /dev/null -m 3 "$1"; }
wait_for() { # url, name, timeout_s
  local t=0
  until listening "$1"; do
    t=$((t+2)); [ "$t" -ge "$3" ] && { echo "NG: $2 が ${3}s 以内に起動しませんでした" >&2; exit 1; }
    sleep 2
  done
}

# ---- 1) doctor: ハードウェア検査と構成決定 -----------------------------------
if [ "${1:-}" = "--doctor" ]; then
  python3 scripts/conversation_doctor.py --explain --movie-server-dir "$MOVIE_SERVER_DIR"
  exit 0
fi
DOCTOR_OUT=$(python3 scripts/conversation_doctor.py --movie-server-dir "$MOVIE_SERVER_DIR")
eval "$DOCTOR_OUT"
if [ -n "$FORCE_PRESET" ]; then
  echo "FORCE_PRESET=$FORCE_PRESET で自動判定を上書きします" >&2
  H3_GATEWAY_PRESET="$FORCE_PRESET"
fi

# ---- 2) 外部サービスの死活(管理はしない、無ければ案内) ---------------------
if ! listening "$TTS_URL/version"; then
  echo "NG: AivisSpeech Engine に接続できません ($TTS_URL)。先に起動してください" >&2
  exit 1
fi
if ! curl -sf -o /dev/null -m 5 "$LLM_URL/models" ${LLM_API_KEY:+-H "Authorization: Bearer $LLM_API_KEY"}; then
  echo "警告: LLM ($LLM_URL) に接続できません。会話開始時に失敗します" >&2
fi

# ---- 3) gateway -----------------------------------------------------------------
GW_URL="http://127.0.0.1:$GATEWAY_PORT"
if listening "$GW_URL/api/v1/backends"; then
  echo "gateway: 稼働中をそのまま使用 ($GW_URL)" >&2
else
  echo "gateway: 起動します" >&2
  (cd "$MOVIE_SERVER_DIR/gateway" && nohup venv/bin/python -m uvicorn app:app \
     --host 0.0.0.0 --port "$GATEWAY_PORT" > "$OLDPWD/$RUN_DIR/gateway.log" 2>&1 &
   echo $! > "$OLDPWD/$RUN_DIR/gateway.pid")
  wait_for "$GW_URL/api/v1/backends" "gateway" 60
fi

# ---- 4) H3 バックエンド(プリセットロード) ----------------------------------
# 同じプリセットが既に稼働中なら再ロードしない(待機プールや常駐モデルを壊さない)
CUR_PRESET=$(curl -sf -m 5 "$GW_URL/api/v1/status" | python3 -c "
import json,sys
try: print((json.load(sys.stdin).get('process') or {}).get('preset') or '')
except Exception: print('')" 2>/dev/null || echo "")
if [ "$CUR_PRESET" = "$H3_GATEWAY_PRESET" ]; then
  echo "backend: preset=$H3_GATEWAY_PRESET は稼働中(再ロードしません)" >&2
else
echo "backend: preset=$H3_GATEWAY_PRESET gpus=$H3_GPUS をロードします(初回は時間がかかります)" >&2
python3 - "$GW_URL" "$H3_GATEWAY_PRESET" "$H3_GPUS" "$H3_OVERRIDES" <<'PYEOF'
import json, sys, urllib.request
url, preset, gpus, ov = sys.argv[1:5]
overrides = dict(kv.split("=", 1) for kv in ov.split(",") if kv)
body = {"backend": "h3", "preset": preset, "gpus": gpus,
        "toggles": {"turbo": True}, "overrides": overrides}
req = urllib.request.Request(f"{url}/api/v1/backend/load",
                             data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=660) as r:
    res = json.load(r)
print(f"backend: {res.get('result')} (pid={res.get('pid')})", file=sys.stderr)
PYEOF
fi

# ---- 5) r-n-v(ヘッドレスレンダラ。画面は開かない) --------------------------
RNV_URL="http://127.0.0.1:$RNV_PORT"
if listening "$RNV_URL/"; then
  echo "r-n-v: 稼働中をそのまま使用 ($RNV_URL)" >&2
  echo "       (構成を変えた場合は ./conversation-down.sh 後に再実行してください)" >&2
else
  echo "r-n-v: 起動します (VIDEO_ENGINE=h3, preset=$H3_GATEWAY_PRESET, idle=$H3_IDLE_MODE)" >&2
  (cd "$RNV_DIR" && set -a && { [ -f .env ] && . ./.env; } && set +a && \
   export VIDEO_ENGINE=h3 GATEWAY_URL="$GW_URL" TTS_URL="$TTS_URL" LLM_URL="$LLM_URL" \
          H3_GATEWAY_PRESET="$H3_GATEWAY_PRESET" H3_GPUS="$H3_GPUS" \
          H3_PROFILE="$H3_PROFILE" H3_IDLE_MODE="$H3_IDLE_MODE" && \
   nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$RNV_PORT" \
     > "$OLDPWD/$RUN_DIR/rnv.log" 2>&1 &
   echo $! > "$OLDPWD/$RUN_DIR/rnv.pid")
  wait_for "$RNV_URL/" "r-n-v" 60
fi

# ---- 6) r-c-v(会話画面 = ユーザーが触る唯一の画面) --------------------------
RCV_URL="http://127.0.0.1:$RCV_PORT"
if listening "$RCV_URL/"; then
  echo "r-c-v: 稼働中をそのまま使用 ($RCV_URL)" >&2
else
  echo "r-c-v: 起動します" >&2
  (set -a && { [ -f .env ] && . ./.env; } && set +a && \
   export NARRATION_URL="$RNV_URL" && \
   nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$RCV_PORT" \
     > "$RUN_DIR/rcv.log" 2>&1 &
   echo $! > "$RUN_DIR/rcv.pid")
  wait_for "$RCV_URL/" "r-c-v" 60
fi

echo "" >&2
echo "=== 起動完了 ===" >&2
echo "会話画面:        $RCV_URL" >&2
echo "キャラ登録(初回のみ): $RNV_URL" >&2
echo "構成: preset=$H3_GATEWAY_PRESET / profile=$H3_PROFILE / 待機=$H3_IDLE_MODE" >&2
command -v xdg-open >/dev/null && xdg-open "$RCV_URL" >/dev/null 2>&1 || true
