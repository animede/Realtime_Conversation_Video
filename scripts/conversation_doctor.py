#!/usr/bin/env python3
"""ハードウェアを検査して会話スタックの構成を決める doctor。

conversation-up.sh から呼ばれ、選んだ構成を KEY=VALUE 行で stdout に出す
(人間向けの診断メッセージは stderr)。単体でも実行できる:

    python3 scripts/conversation_doctor.py            # 診断 + 構成出力
    python3 scripts/conversation_doctor.py --explain   # 診断のみ(構成出力なし)

構成表(2026-10-08 実測に基づく。diffusers-movie-server README の
「24GB / 32GB 級 VRAM で動かす場合の注意点」参照):

| 検出                             | preset                     | gpus | profile              | idle_mode      |
|----------------------------------|----------------------------|------|----------------------|----------------|
| 2GPU & GPU0>=90GB                | dual-realtime-ref2va       | 0,1  | h3-portrait-352x640  | fl2va          |
| 2GPU & GPU0>=31GB & GPU1>=7.5GB  | dual-realtime-ref2va-32gb  | 0,1  | h3-portrait-352x640  | fl2va          |
| 単騎 GPU0>=31GB                  | ref2va-only-32gb           | 0    | h3-portrait-320x448  | silent_ref2va  |
| 単騎 GPU0>=23GB                  | ref2va-only-24gb           | 0    | h3-portrait-320x448  | silent_ref2va  |
| それ未満                         | (エラー)                 |      |                      |                |

ホスト RAM が 70GB 未満なら H3_REF_PINNED=0 を override に足す
(pinned 常駐 ~45GiB が 64GB 機に収まらないため。movie-server README 注意点3)。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

GIB = 1024**3


def info(msg: str) -> None:
    print(msg, file=sys.stderr)


def fail(msg: str) -> None:
    print(f"NG: {msg}", file=sys.stderr)
    sys.exit(1)


def query_gpus() -> list[dict]:
    if not shutil.which("nvidia-smi"):
        fail("nvidia-smi が見つかりません(NVIDIA ドライバ必須)")
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.free",
         "--format=csv,noheader,nounits"],
        capture_output=True, text=True, check=True).stdout
    gpus = []
    for line in out.strip().splitlines():
        idx, name, total, free = [x.strip() for x in line.split(",")]
        gpus.append({"index": int(idx), "name": name,
                     "total_gb": float(total) / 1024, "free_gb": float(free) / 1024})
    return gpus


def host_ram_gb() -> float:
    for line in open("/proc/meminfo"):
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) / 1024 / 1024
    return 0.0


def decide(gpus: list[dict], ram_gb: float) -> dict:
    g0 = gpus[0]
    g1 = gpus[1] if len(gpus) > 1 else None
    overrides: dict[str, str] = {"H3_MIN_SECONDS": "2.3"}
    if len(gpus) >= 2 and g0["total_gb"] >= 90:
        cfg = dict(preset="dual-realtime-ref2va", gpus="0,1",
                   profile="h3-portrait-352x640", idle_mode="fl2va",
                   need_free_gb=50.0)
    elif len(gpus) >= 2 and g0["total_gb"] >= 31 and g1 and g1["total_gb"] >= 7.5:
        cfg = dict(preset="dual-realtime-ref2va-32gb", gpus="0,1",
                   profile="h3-portrait-352x640", idle_mode="fl2va",
                   need_free_gb=28.0)
    elif g0["total_gb"] >= 31:
        cfg = dict(preset="ref2va-only-32gb", gpus="0",
                   profile="h3-portrait-320x448", idle_mode="silent_ref2va",
                   need_free_gb=28.0)
    elif g0["total_gb"] >= 23:
        cfg = dict(preset="ref2va-only-24gb", gpus="0",
                   profile="h3-portrait-320x448", idle_mode="silent_ref2va",
                   need_free_gb=23.0)
    else:
        fail(f"GPU0 ({g0['name']}, {g0['total_gb']:.0f}GB) はリアルタイム会話の"
             "対応下限(24GB級)未満です。静止画・短尺の低VRAMモードは "
             "Diffusers_minimax-h3 の 16gb-proj 等を参照してください")
    if ram_gb < 70 and cfg["preset"].startswith("ref2va-only"):
        overrides["H3_REF_PINNED"] = "0"
        info(f"注意: ホスト RAM {ram_gb:.0f}GB < 70GB のため H3_REF_PINNED=0 を適用"
             "(pinned 常駐 ~45GiB が収まらないため。会話ターンの復帰が +7s 程度遅くなる)")
    if g0["free_gb"] < cfg["need_free_gb"]:
        info(f"警告: GPU0 の空き {g0['free_gb']:.1f}GB < 推奨 {cfg['need_free_gb']:.0f}GB。"
             "他プロセス(デスクトップ描画・他アプリ)を減らさないと OOM の可能性があります。"
             "TTS/LLM は同じ GPU に同居できません")
    cfg["overrides"] = overrides
    return cfg


def check_caches(movie_server_dir: Path, cfg: dict) -> None:
    prequant = movie_server_dir / "backends/minimax-h3/models/prequant"
    ref_cache = prequant / "transformer_ref_pruned_ck_w4a8/pruned_ck_w4a8_state.pt"
    base_cache = prequant / "transformer_base_pruned_ck_w4a8/pruned_ck_w4a8_state.pt"
    if not ref_cache.is_file():
        info("注意: ref 側 ck-w4a8 キャッシュが未作成です。初回の会話リクエスト時に"
             "自動作成されますが、bf16 重み ~38GB のダウンロードと空きホスト RAM 45GB が"
             "必要で、数十分かかります(2回目以降は数秒)")
    if cfg["preset"].startswith("ref2va-only") or "32gb" in cfg["preset"]:
        if not base_cache.is_file():
            info("注意: base 側 ck-w4a8 キャッシュが未作成です。待機(fl2va)を使う場合は"
                 "Kijai/MiniMax-H3-experimental の minimax_h3_fl2va_pruned_w4a8_mixed."
                 "safetensors(12.5GB)をダウンロードし、backends/minimax-h3/scripts/"
                 "convert_kijai_w4a8.py で変換してください(GPU 不要。silent_ref2va "
                 "運用なら無くても動きます)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--explain", action="store_true", help="診断のみ(構成出力なし)")
    ap.add_argument("--movie-server-dir", default=os.getenv("MOVIE_SERVER_DIR", ""))
    args = ap.parse_args()

    gpus = query_gpus()
    ram = host_ram_gb()
    info("=== conversation doctor ===")
    for g in gpus:
        info(f"GPU{g['index']}: {g['name']}  total {g['total_gb']:.0f}GB / free {g['free_gb']:.1f}GB")
    info(f"ホスト RAM: {ram:.0f}GB")

    cfg = decide(gpus, ram)
    info(f"→ 構成: preset={cfg['preset']} gpus={cfg['gpus']} "
         f"profile={cfg['profile']} idle_mode={cfg['idle_mode']}")
    if args.movie_server_dir:
        check_caches(Path(args.movie_server_dir), cfg)

    if args.explain:
        return
    print(f"H3_GATEWAY_PRESET={cfg['preset']}")
    print(f"H3_GPUS={cfg['gpus']}")
    print(f"H3_PROFILE={cfg['profile']}")
    print(f"H3_IDLE_MODE={cfg['idle_mode']}")
    ov = cfg["overrides"]
    print("H3_OVERRIDES=" + ",".join(f"{k}={v}" for k, v in ov.items()))


if __name__ == "__main__":
    main()
