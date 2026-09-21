#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PAIR PWA 圖示產生器 —— 只用標準庫（zlib + struct），零外部依賴。

用法:
    python3 scripts/make-icons.py              # 寫入 <repo>/icons/
    python3 scripts/make-icons.py --out /tmp/x # 指定輸出目錄

設計（與站台 index.html 的 CSS 變數同色，缺一不可）:
    --bg:#0d0d11、--ink:#e9e6df、--amber:#ffb84d
    背景 #0d0d11 填滿；兩個 #e9e6df 方塊；中間一條 #ffb84d 連線
    （站上的棋盤連線本身就是 stroke:var(--amber)）。

可重現性:
    不下載圖片、不用 Pillow / canvas / ImageMagick。PNG 只寫 IHDR / IDAT / IEND，
    不含 tIME 時間戳也沒有任何隨機數或日期，所以同樣輸入必然產生同樣的位元組。
    tests/test-pwa.js 會實際重跑一次本腳本並比對 sha256。
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import zlib
from pathlib import Path

# ---------------------------------------------------------------- 設計 token
# 與 index.html 的 :root CSS 變數一字不差，改這裡就要同步改站上變數。
BG = (0x0D, 0x0D, 0x11)      # --bg    深色底
INK = (0xE9, 0xE6, 0xDF)     # --ink   棋子方塊（白/淡灰）
AMBER = (0xFF, 0xB8, 0x4D)   # --amber 連線（琥珀，站上 .tile-line 同色）

# 構圖以「內容盒」為單位：總寬 = 2*BOX + GAP = 0.72，總高 = BOX = 0.26
BOX = 0.26    # 方塊邊長
GAP = 0.20    # 兩方塊間距（＝連線長度）
LINE = 0.040  # 連線粗細
COMP = 2 * BOX + GAP  # 0.72

# 檔名 -> (邊長, 內容盒寬度佔畫布比例)
#   "any" 圖示構圖在中央約 76% 直徑內；maskable 再縮到約 62%，
#   確保 Android 裁圓（安全區＝中央 80% 直徑）時不會切到圖素，
#   同時背景填滿整張畫布（color type 2，無 alpha → 不會被填黑）。
ICONS = {
    "icon-192.png": (192, 0.72),
    "icon-512.png": (512, 0.72),
    "icon-maskable-512.png": (512, 0.62),
    "apple-touch-icon-180.png": (180, 0.72),  # iOS 不支援透明 → 全不透明
}


# ------------------------------------------------------- 幾何：逐像素覆蓋率
def _axis_coverage(lo: float, hi: float, size: int) -> list[float]:
    """回傳 [lo, hi] 與每個像素格 [i, i+1] 的重疊長度（0..1）。

    解析式計算而非取樣，所以邊緣抗鋸齒是精確值，且完全決定性。
    """
    cov = [0.0] * size
    start = max(0, int(lo))
    end = min(size, int(hi) + 1)
    for i in range(start, end):
        a = lo if lo > i else float(i)
        b = hi if hi < i + 1 else float(i + 1)
        if b > a:
            cov[i] = b - a
    return cov


def _layers(size: int, coverage: float):
    """回傳 [(x 覆蓋率, y 覆蓋率, 顏色)]，依繪製順序：左方塊、右方塊、連線。"""
    scale = coverage * size / COMP     # 內容單位 -> 像素
    center = size / 2.0
    shapes = (
        ((-COMP / 2, -BOX / 2, -COMP / 2 + BOX, BOX / 2), INK),
        ((COMP / 2 - BOX, -BOX / 2, COMP / 2, BOX / 2), INK),
        ((-GAP / 2, -LINE / 2, GAP / 2, LINE / 2), AMBER),
    )
    out = []
    for (x0, y0, x1, y1), color in shapes:
        fx = _axis_coverage(center + x0 * scale, center + x1 * scale, size)
        fy = _axis_coverage(center + y0 * scale, center + y1 * scale, size)
        out.append((fx, fy, color))
    return out


def render_rgb(size: int, coverage: float) -> list[bytearray]:
    """回傳每列 RGB bytes（不透明，無 alpha 通道）。"""
    layers = _layers(size, coverage)
    rows: list[bytearray] = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r, g, b = BG
            for fx, fy, col in layers:
                f = fx[px] * fy[py]
                if f > 0.0:
                    inv = 1.0 - f
                    r = r * inv + col[0] * f
                    g = g * inv + col[1] * f
                    b = b * inv + col[2] * f
            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5)))
        rows.append(row)
    return rows


# ------------------------------------------------------------ PNG 編碼（手寫）
def _chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def encode_png(width: int, height: int, rows: list[bytearray]) -> bytes:
    """RGB / 8-bit / 無交錯；只寫 IHDR + IDAT + IEND（刻意不寫 tIME）。"""
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0 (None)
        raw += row
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )


def build_png(size: int, coverage: float) -> bytes:
    return encode_png(size, size, render_rgb(size, coverage))


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="產生 PAIR PWA 圖示（純 Python）")
    ap.add_argument("--out", default=str(repo / "icons"),
                    help="輸出目錄（預設 <repo>/icons）")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    for name, (size, coverage) in ICONS.items():
        data = build_png(size, coverage)
        (out_dir / name).write_bytes(data)
        total += len(data)
        digest = hashlib.sha256(data).hexdigest()
        print(f"{name:28s} {size}x{size:4d}  {len(data):7d} bytes  sha256={digest[:16]}")
    print(f"{'TOTAL':28s} {'':9s}  {total:7d} bytes  -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
