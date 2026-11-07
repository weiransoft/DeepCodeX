#!/usr/bin/env bash
# 启动本机语音 sidecar（幂等）
#
# 为什么需要这个脚本：sidecar 是独立 Python 进程，桌面端与 Web 引擎都不会
# 自动拉起它（引擎只管 HTTP 转发，不管进程生命周期）。没有这个入口，每次
# 都要手工拼「venv 路径 + HF_ENDPOINT + 脚本路径」，而且很容易忘掉 HF_ENDPOINT
# 导致模型下载失败。
#
# 用法：
#   bash scripts/voice/start.sh              # 后台启动（已在跑则跳过）
#   bash scripts/voice/start.sh --foreground # 前台启动，便于看日志
#   VOICE_PORT=8792 bash scripts/voice/start.sh
#
# 退出码：0 = 已在运行或启动成功；1 = 依赖缺失或启动失败。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_PY="$HERE/.venv/bin/python"
PORT="${VOICE_PORT:-8791}"
HOST="${VOICE_HOST:-127.0.0.1}"
# 模型权重走镜像：HF 直连在本机历史上不可达，只 export 在安装脚本里不会继承
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
# TTS 文本前端规范化：2026-11-07 起按产品决策默认打开（URL / JSON / 路径 /
# 单位 / 缩写不再逐字母念）。DCX_VOICE_TNS=0 bash scripts/voice/start.sh 可一键回退。
export DCX_VOICE_TNS="${DCX_VOICE_TNS:-1}"
# 结构感知分块（2026-11-07 P0）：默认关，灰度通过后再默认开。
# 打开需重启 sidecar：DCX_VOICE_ATOMIC_CHUNK=1 bash scripts/voice/start.sh
# 前端偏好 dcx.voice.atomicChunk.v1（localStorage）是必要条件：它保证完整
# JSON 进入同一个请求。真机 A/B 的 6.84% 正是在本变量关闭下测得，
# 服务端这层只是「规范化后残留拉丁词」的可选增强，不是收益来源。
export DCX_VOICE_ATOMIC_CHUNK="${DCX_VOICE_ATOMIC_CHUNK:-0}"
LOG_DIR="${HOME}/.deepcode/logs"
LOG_FILE="$LOG_DIR/voice.log"
FOREGROUND=0

for arg in "$@"; do
  case "$arg" in
    --foreground | -f) FOREGROUND=1 ;;
    --help | -h)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（用 --help 查看用法）" >&2
      exit 1
      ;;
  esac
done

# 1) 已在监听就直接返回：重复启动会以 EADDRINUSE 退出，看起来像失败
if curl -sf --noproxy '*' --max-time 2 "http://$HOST:$PORT/health" >/dev/null 2>&1; then
  echo "✅ 语音 sidecar 已在运行：http://$HOST:$PORT"
  exit 0
fi

# 2) 依赖检查：venv 不存在时给一句话，而不是让 Python 抛 ImportError
if [ ! -x "$VENV_PY" ]; then
  echo "!! 未找到虚拟环境：$VENV_PY" >&2
  echo "   先跑一次：bash scripts/voice/setup.sh" >&2
  exit 1
fi

if [ "$FOREGROUND" = "1" ]; then
  echo "==> 前台启动（Ctrl+C 退出）"
  exec "$VENV_PY" "$HERE/mlx_voice_server.py" --host "$HOST" --port "$PORT"
fi

# 3) 后台启动并等待就绪：返回时服务真的能接请求，而不是「进程起来了但模型还在加载」
mkdir -p "$LOG_DIR"
echo "==> 启动语音 sidecar（日志：${LOG_FILE}）"
nohup "$VENV_PY" "$HERE/mlx_voice_server.py" --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
PID=$!
echo "    pid=$PID"

for _ in $(seq 1 40); do
  if curl -sf --noproxy '*' --max-time 2 "http://$HOST:$PORT/health" >/dev/null 2>&1; then
    # 端口可能被别的残留进程占着，确认我们自己那个还活着再说成功
    if kill -0 "$PID" 2>/dev/null; then
      echo "✅ 语音 sidecar 就绪：http://$HOST:$PORT"
      exit 0
    fi
    echo "⚠️  端口 $PORT 已被其他进程占用（不是本次启动的 pid=${PID}）" >&2
    exit 1
  fi
  sleep 1
done

echo "!! 40 秒内未就绪，最后 20 行日志：" >&2
tail -20 "$LOG_FILE" >&2 || true
kill "$PID" 2>/dev/null || true
exit 1
