import os
import re
import json

ROOT = "/Users/wangwei/Documents/VG/DeepCodeX-cli/packages/core/src/eag"

CHECKS = {
    "C1_loop_cap": r"maxToolRounds|maxRounds|maxIterations|maxLoops|roundLimit|iterationLimit|MAX_[A-Z_]*(ROUND|LOOP|ITER|ATTEMPT|RETRY)|STORM_LIMIT|NO_PROGRESS|consecutiveFailures|while\s*\(|for\s*\(\s*let\s+\w*(round|iter|attempt|i)\b",
    "C2_own_executor": r"new ToolExecutor|ToolExecutor\(|buildUserPrompt|toolRounds|maxToolRounds|assistantMessages",
    "C3_truncation": r"\.slice\(0,\s*\d+\)|\.substring\(0,\s*\d+\)|truncat|MAX_[A-Z_]*CHARS|maxChars",
    "C4_state_rebuild": r"normalize\w+\(|\.\.\.(record|state|runResult|details|snapshot|config)\b|Object\.freeze\(\{|JSON\.parse\(JSON\.stringify",
    "C5_failure_feedback": r"feedback|Feedback|failedTestIds|abortReason|failureContext|lastFailure",
    "C6_fingerprint": r"fingerprint|Fingerprint|dedup|dedupe|seen[A-Z]\w*|\bSet<string>",
    "C7_honest_degrade": r"catch\s*\(|available\s*=\s*(true|false)|success:\s*true|testPassed|degraded\(",
    "C8_env_switch": r"process\.env\.[A-Z_][A-Z_0-9]*",
    "C9_stats_scope": r"changedFiles|porcelain|git status|baselineDirty|captureGitSnapshot",
    "C10_subprocess": r"spawnSync|execSync|\bspawn\(|execFileSync",
    "C11_guard_chain": r"Guard\b|guard\b|deny|DENIAL|blocked|abort",
    "C12_llm_call": r"LlmClient|callLlm|chat\(|complete\(|generateText|invokeLlm|llmClient|LLM",
}

rows = []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames.sort()
    for fn in sorted(filenames):
        if not fn.endswith(".ts"):
            continue
        path = os.path.join(dirpath, fn)
        rel = os.path.relpath(path, "/Users/wangwei/Documents/VG/DeepCodeX-cli")
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        hits = {}
        for key, pat in CHECKS.items():
            rx = re.compile(pat)
            found = []
            for idx, line in enumerate(lines, 1):
                if rx.search(line):
                    found.append(idx)
                    if len(found) >= 6:
                        break
            if found:
                hits[key] = found
        # 风险分：核心执行链路命中项加权
        weight = (
            3 * len(hits.get("C1_loop_cap", []))
            + 4 * len(hits.get("C2_own_executor", []))
            + 2 * len(hits.get("C5_failure_feedback", []))
            + 2 * len(hits.get("C6_fingerprint", []))
            + 2 * len(hits.get("C9_stats_scope", []))
            + 2 * len(hits.get("C7_honest_degrade", []))
            + 1 * len(hits.get("C10_subprocess", []))
            + 1 * len(hits.get("C12_llm_call", []))
        )
        rows.append({
            "file": rel,
            "lines": len(lines),
            "hits": hits,
            "weight": weight,
        })

rows.sort(key=lambda r: (-r["weight"], r["file"]))
with open("/tmp/dcx-eag-scan.json", "w", encoding="utf-8") as fh:
    json.dump(rows, fh, ensure_ascii=False, indent=1)

print("TOTAL_FILES", len(rows))
print("TOTAL_LINES", sum(r["lines"] for r in rows))
for label, lo, hi in [("HIGH", 12, 10**9), ("MID", 4, 11), ("LOW", 0, 3)]:
    sel = [r for r in rows if lo <= r["weight"] <= hi]
    print(label, len(sel))
print("--- TOP 35 ---")
for r in rows[:35]:
    keys = ",".join(k.split("_")[0] for k in r["hits"].keys())
    print(f'{r["weight"]:>4} {r["lines"]:>5} {r["file"]}  [{keys}]')
