#!/usr/bin/env bash
# conversation-up.sh が起動したサービスだけを逆順に止める
# (既に動いていて「そのまま使用」したものには触らない)。
set -eu
cd "$(dirname "$0")"
RUN_DIR=.conversation-run

stop_one() { # name
  local pidfile="$RUN_DIR/$1.pid"
  [ -f "$pidfile" ] || { echo "$1: この launcher からは起動していない(スキップ)"; return 0; }
  local pid
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    echo "$1: 停止しました (pid $pid)"
  else
    echo "$1: 既に終了 (pid $pid)"
  fi
  rm -f "$pidfile"
}

stop_one rcv
stop_one rnv
stop_one gateway
echo "完了(launcher 起動分のみ。既存稼働を使っていたサービスは残っています)"
