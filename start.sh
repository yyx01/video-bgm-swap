#!/usr/bin/env bash
# 视频BGM替换器 - 本地服务一键启动 (Linux/macOS)
set -e
cd "$(dirname "$0")"

echo "============================================"
echo "  视频BGM替换器 - 本地服务启动器"
echo "============================================"
echo ""
echo "  [默认] 仅代理模式（零依赖，稳定轻量）"
echo "  [AI]   人声分离模式（需 demucs，加 --ai 参数）"
echo ""

PYTHON=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PYTHON="$c"; break; fi
done

if [ -z "$PYTHON" ]; then
  echo "[错误] 未找到 python3，请先安装 Python 3.8+"
  exit 1
fi

AI_ARG=""
if "$PYTHON" -c "import demucs, torch, websockets, numpy" >/dev/null 2>&1; then
  read -r -p "检测到 AI 依赖，是否启用 AI 人声分离？(y/n，默认 n): " AI_CHOICE
  if [ "$AI_CHOICE" = "y" ]; then AI_ARG="--ai"; fi
else
  echo "[提示] 未检测到 AI 依赖（demucs），将以\"仅代理\"模式启动。"
  echo "       在线搜索 / BGM替换可用；如需人声分离请先安装:"
  echo "       pip install demucs torch websockets numpy"
fi

echo ""
echo "正在启动服务，请保持此窗口开启... (Ctrl+C 停止)"
echo ""
exec "$PYTHON" bgm-separate-server.py $AI_ARG