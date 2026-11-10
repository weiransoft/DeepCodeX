#!/usr/bin/env bash
# ============================================================================
# jev 循环决策真机验证脚本（2026-11-10，docs/dev/jev-loop-decision-20261110.md）
#
# 目标网关：as1.hongene-sh.com/v1（NeoHorse-Jev-4B，网关路由 model:"jev"）
#
# 验证项（对应方案 §6 全流程功能测试）：
#   1. 契约探测：/v1/decision 与 /v1/systemone 同构请求，校验 200 响应契约
#      （model / answers.choice / confidence / input_tokens）；
#   2. 成功率：N 次真实请求统计 HTTP 200 占比（默认 30 次）；
#   3. 延迟分位：keep-alive 连接复用下的 p50 / p95 / p99（对照同步 RTT 口径；
#      业务侧有效延迟由并行预取承担，见方案 §4.3——同步 RTT 无法直接达
#      P99<100ms 属预期，报告口径须如实披露）；
#   4. 判定准确率样本：构造「有进展 / 空转」两类场景，统计 jev 判定与
#      人工标注的一致率。
#
# 密钥来源（严禁入库，遵守用户密钥规则）：
#   - 优先环境变量 DEEPCODE_JEV_API_KEY；
#   - 其次读取 ~/.memsearch/config.toml（0600，api_key = "..." 行）。
#
# 用法：
#   bash tests/scripts/jev-real-gateway-verify.sh [成功样本数，默认 30]
# ============================================================================

set -euo pipefail

# --- 基础环境（macOS 默认 PATH 可能缺 curl） --------------------------------
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

GATEWAY_BASE="${DEEPCODE_JEV_BASE_URL:-https://as1.hongene-sh.com/v1}"
SAMPLES="${1:-30}"
TIMEOUT_SECONDS=10

# --- 密钥解析 ----------------------------------------------------------------
API_KEY="${DEEPCODE_JEV_API_KEY:-}"
if [[ -z "$API_KEY" && -f "$HOME/.memsearch/config.toml" ]]; then
  # 提取 api_key = "..." 行（仅本地读取，不回显明文）
  API_KEY="$(sed -n 's/^api_key[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' "$HOME/.memsearch/config.toml" | head -1)"
fi
if [[ -z "$API_KEY" ]]; then
  echo "[FATAL] 未找到 jev 网关密钥：请设置 DEEPCODE_JEV_API_KEY 或提供 ~/.memsearch/config.toml" >&2
  exit 1
fi

# --- 临时工作区（延迟样本与响应体） ------------------------------------------
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/jev-verify.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

# 通用判定请求体：continue_loop（choice）+ is_empty_turn（choice）双问，
# 契约与 packages/core/src/common/jev-loop-decision.ts §4.2 问题集一致。
REQUEST_BODY_TMPL='{"model":"jev","messages":[{"role":"user","content":"TASK_GOAL"},{"role":"assistant","content":"VISIBLE_TURN"}],"state":"mode=task; turns=__TURNS__","questions":{"continue_loop":{"type":"choice","instructions":"判断当前任务执行循环是否应继续","criteria":{"continue":"循环仍有进展或合理的尝试空间","stop":"循环空转（重复尝试、无产出），应暂停"}},"is_empty_turn":{"type":"choice","instructions":"判断最近一轮是否为空循环（无可见回复且无有效工具产出）","criteria":{"yes":"本轮是空循环","no":"本轮有实质内容或工具产出"}}}}'

# 单次请求（复用连接由 curl 同一进程多次调用 + HTTP/2 或 keep-alive 自动管理；
# 这里用 curl 每次独立调用以贴近客户端真实行为，分位口径在报告中注明）
call_decision() {
  local endpoint="$1" body="$2" out="$3"
  local http_code
  http_code="$(curl -sS -o "$out" -w '%{http_code}' \
    --max-time "$TIMEOUT_SECONDS" \
    -X POST "$GATEWAY_BASE/$endpoint" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || echo "000")"
  echo "$http_code"
}

echo "=================================================================="
echo "jev 真机验证：${GATEWAY_BASE}（样本 ${SAMPLES} 次）"
echo "=================================================================="

# ============================================================================
# 1. 契约探测：/v1/decision
# ============================================================================
echo ""
echo "[1] 契约探测 /v1/decision"
BODY="$(echo "$REQUEST_BODY_TMPL" | sed "s|TASK_GOAL|修复单元测试|; s|VISIBLE_TURN|已执行 bash: true，无输出；工具成功1次/失败0次|; s|__TURNS__|3|")"
CODE="$(call_decision "decision" "$BODY" "$WORKDIR/decision.json")"
if [[ "$CODE" != "200" ]]; then
  echo "  [FAIL] HTTP $CODE"; cat "$WORKDIR/decision.json" >&2; exit 1
fi
echo "  [OK] HTTP 200"
# 契约字段校验（python3 做 JSON 断言，避免 jq 依赖）
python3 - "$WORKDIR/decision.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data.get("model") == "NeoHorse-Jev-4B", f"model 不符: {data.get('model')}"
answers = data["answers"]
cl = answers["continue_loop"]
assert cl["type"] == "choice" and cl["choice"] in ("continue", "stop"), cl
assert 0.0 <= cl["confidence"] <= 1.0, cl
et = answers.get("is_empty_turn")
if et is not None:
    assert et["type"] == "choice" and et["choice"] in ("yes", "no"), et
assert isinstance(data.get("input_tokens"), int), data.get("input_tokens")
print(f"  [OK] 契约校验通过: continue_loop={cl['choice']} conf={cl['confidence']} input_tokens={data['input_tokens']}")
PY

# ============================================================================
# 2. 契约探测：/v1/systemone（同构请求，应返回同构响应 + usage）
# ============================================================================
echo ""
echo "[2] 契约探测 /v1/systemone"
CODE="$(call_decision "systemone" "$BODY" "$WORKDIR/systemone.json")"
if [[ "$CODE" != "200" ]]; then
  echo "  [FAIL] HTTP $CODE"; cat "$WORKDIR/systemone.json" >&2; exit 1
fi
echo "  [OK] HTTP 200"
python3 - "$WORKDIR/systemone.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data.get("model") == "NeoHorse-Jev-4B", f"model 不符: {data.get('model')}"
assert "continue_loop" in data["answers"], data["answers"].keys()
usage = data.get("usage")
print(f"  [OK] systemone 契约通过; usage={'有' if usage else '无'}: {usage}")
PY

# ============================================================================
# 3. 成功率 + 延迟分位（N 次 decision 请求，交替「有进展/空转」两种观测）
# ============================================================================
echo ""
echo "[3] 成功率 + 延迟分位（$SAMPLES 次）"
SUCCESS=0
FAIL=0
for i in $(seq 1 "$SAMPLES"); do
  if (( i % 2 == 0 )); then
    TURN="已读取 src/main.py 并修复空指针异常，工具成功2次"
  else
    TURN="本轮无可见正文且无工具调用"
  fi
  B="$(echo "$REQUEST_BODY_TMPL" | sed "s|TASK_GOAL|修复单元测试|; s|VISIBLE_TURN|$TURN|; s|__TURNS__|$i|")"
  CODE="$(call_decision "decision" "$B" "$WORKDIR/loop.json")"
  if [[ "$CODE" == "200" ]]; then
    SUCCESS=$((SUCCESS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  [WARN] 第 $i 次 HTTP $CODE"
  fi
done
RATE=$(( SUCCESS * 100 / SAMPLES ))
echo "  成功率：${SUCCESS}/${SAMPLES}（${RATE}%）"

# ============================================================================
# 4. 判定准确率样本（continue_loop / is_empty_turn 与人工标注一致率）
# ============================================================================
echo ""
echo "[4] 判定准确率样本（复用上述 $SAMPLES 次响应记录）"
# 重新采集带记录的样本：偶数轮=有进展（期望 continue/no），奇数轮=空转（期望 stop/yes 边界宽松）
MATCH=0
TOTAL=0
declare -a EXPECT_CONTINUE EXPECT_EMPTY
for i in $(seq 1 "$SAMPLES"); do
  if (( i % 2 == 0 )); then
    TURN="已读取 src/main.py 并修复空指针异常，工具成功2次，测试通过"
    EXPECT_CONTINUE="continue"; EXPECT_EMPTY="no"
  else
    TURN="本轮无可见正文且无工具调用（第 $i 轮重复同样空转）"
    EXPECT_CONTINUE="stop"; EXPECT_EMPTY="yes"
  fi
  B="$(echo "$REQUEST_BODY_TMPL" | sed "s|TASK_GOAL|修复单元测试|; s|VISIBLE_TURN|$TURN|; s|__TURNS__|$i|")"
  CODE="$(call_decision "decision" "$B" "$WORKDIR/acc.json")"
  if [[ "$CODE" != "200" ]]; then
    echo "  [WARN] 第 $i 次请求失败 HTTP ${CODE}，跳过"
    continue
  fi
  READ_OUT="$(python3 - "$WORKDIR/acc.json" "$EXPECT_CONTINUE" "$EXPECT_EMPTY" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
a = data["answers"]
cl, et = a["continue_loop"], a.get("is_empty_turn")
exp_c, exp_e = sys.argv[2], sys.argv[3]
hit_c = cl["choice"] == exp_c
hit_e = (et is None) or (et["choice"] == exp_e)
print(f"{'HIT' if (hit_c and hit_e) else 'MISS'} c={cl['choice']}/{exp_c} conf={cl['confidence']:.2f} e={et['choice'] if et else 'N/A'}/{exp_e}")
PY
)"
  TOTAL=$((TOTAL + 1))
  if [[ "$READ_OUT" == HIT* ]]; then
    MATCH=$((MATCH + 1))
  fi
  echo "  第 $i 轮: $READ_OUT"
done
if (( TOTAL > 0 )); then
  ACC=$(( MATCH * 100 / TOTAL ))
  echo "  判定一致率：${MATCH}/${TOTAL}（${ACC}%）"
else
  echo "  [FATAL] 无有效样本"
  exit 1
fi

# ============================================================================
# 5. 延迟分位：keep-alive 复用连接（python3 http.client 单连接连发）
# ============================================================================
echo ""
echo "[5] 延迟分位（keep-alive 连接复用，10 次）"
python3 - "$GATEWAY_BASE" "$API_KEY" <<'PY'
import json, sys, time, http.client
from urllib.parse import urlparse
base, key = sys.argv[1], sys.argv[2]
u = urlparse(base)
conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=10)
path = (u.path.rstrip("/") + "/decision") if u.path else "/v1/decision"
body = json.dumps({
    "model": "jev",
    "messages": [
        {"role": "user", "content": "任务目标：修复单元测试"},
        {"role": "assistant", "content": "工具调用：成功1次/失败0次"},
    ],
    "state": "mode=task; turns=3",
    "questions": {
        "continue_loop": {"type": "choice", "instructions": "判断循环是否继续",
                          "criteria": {"continue": "有进展", "stop": "空转"}},
        "is_empty_turn": {"type": "choice", "instructions": "最近一轮是否空循环",
                          "criteria": {"yes": "是", "no": "否"}},
    },
})
headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
latencies = []
for i in range(10):
    t0 = time.perf_counter()
    conn.request("POST", path, body=body, headers=headers)
    resp = conn.getresponse()
    resp.read()
    dt_ms = (time.perf_counter() - t0) * 1000
    assert resp.status == 200, f"第 {i} 次 HTTP {resp.status}"
    latencies.append(dt_ms)
conn.close()
latencies.sort()
p50 = latencies[len(latencies) // 2]
p95 = latencies[int(len(latencies) * 0.95) - 1]
p99 = latencies[-1]
print(f"  p50={p50:.0f}ms  p95={p95:.0f}ms  p99={p99:.0f}ms  min={latencies[0]:.0f}ms  max={latencies[-1]:.0f}ms")
print("  口径说明：同步 RTT 受网络物理往返限制；业务有效延迟由并行预取承担（决策与")
print("  用户思考时间/工具执行重叠，join 开销≈0），P99<100ms 目标口径见方案 §4.3。")
PY

echo ""
echo "=================================================================="
echo "验证完成。结论口径："
echo "  - 契约：decision/systemone 均须 200 且字段齐备"
echo "  - 成功率：目标 ≥ 99%（网关偶发 5xx 计入失败）"
echo "  - 延迟：keep-alive 分位为同步 RTT 上界，供报告引用"
echo "  - 准确率：有进展/空转二分类人工标注一致率，目标 ≥ 80%"
echo "=================================================================="
