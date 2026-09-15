#!/usr/bin/env bash
# OpenPi Desktop: runtime is self-contained — keep variable export, skip all installs/checks.
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DOCX_SKILL_DIR="$SKILL_ROOT"
export FONT_DIR="${FONT_DIR:-}"
echo "[OpenPi] 内置运行时已就绪：DOCX_SKILL_DIR=$DOCX_SKILL_DIR（依赖已全部预装，无需安装）"
