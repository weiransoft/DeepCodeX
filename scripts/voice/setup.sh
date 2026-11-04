#!/usr/bin/env bash
# 司南的本机语音依赖安装（Apple Silicon / macOS）
#
# 做三件事：建 venv → 装 mlx-audio 与 mlx-whisper → 自检。
# 不下载模型：模型在首次合成/识别时按需拉取，避免"装完等 20 分钟不知在干嘛"。
#
# ## 为什么默认用国内镜像
#
# 实测：pypi.org 在本机单次索引请求要 6.6s，uv 解析这棵依赖树会跑到超时被杀
# （exit 137），装 18 分钟一个包都没落地。换成阿里云镜像后同一台机器
# 单次请求 0.12s，全部装完不到 1 分钟。这不是"可选的优化"，是能不能装上的区别。
#
# 覆盖方式：PYPI_INDEX=https://pypi.org/simple bash setup.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"
PYPI_INDEX="${PYPI_INDEX:-https://mirrors.aliyun.com/pypi/simple}"
# HuggingFace 直连在本机历史上不可达，模型权重统一走镜像
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

echo "==> 工作目录：$HERE"
echo "==> PyPI 源：$PYPI_INDEX"
echo "==> 模型源：HF_ENDPOINT=$HF_ENDPOINT"

if ! command -v uv >/dev/null 2>&1; then
  echo "!! 未找到 uv。安装：curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  echo "   （也可以改用：python3 -m venv .venv && .venv/bin/pip install -i $PYPI_INDEX mlx-audio mlx-whisper）" >&2
  exit 1
fi

if [ ! -d "$VENV" ]; then
  echo "==> 创建虚拟环境（Python 3.12）"
  uv venv --python 3.12 "$VENV"
fi

echo "==> 安装依赖（mlx-audio / mlx-whisper，约 300MB+）"
uv pip install --python "$VENV/bin/python" -i "$PYPI_INDEX" mlx-audio mlx-whisper

echo "==> 自检"
"$VENV/bin/python" "$HERE/mlx_voice_server.py" --selftest || {
  echo "!! 自检未通过：按上面每一项的 reason 排查" >&2
  exit 1
}

cat <<'TIP'

✅ 依赖就绪。接下来：

  1) 启动 sidecar（另开一个终端，保持前台运行便于看日志）
       HF_ENDPOINT=https://hf-mirror.com \
         scripts/voice/.venv/bin/python scripts/voice/mlx_voice_server.py

  2) 打开 DeepCode → 设置 → 司南 → 声音 → 勾选「启用语音对话」
     点「试听」确认音色；不满意就改「音色描述」再试

  3) 回到对话页，按住输入框右侧的麦克风说话，松开即发送

首次合成/识别会下载模型（Qwen3-TTS VoiceDesign 8bit ≈ 1.8GB、
Whisper large-v3-turbo ≈ 1.6GB），那一次会慢；之后常驻内存，
按句合成通常在百毫秒级。

HF_ENDPOINT 必须传给 sidecar 进程——只 export 在安装脚本里不会继承给之后启动的服务。
TIP
