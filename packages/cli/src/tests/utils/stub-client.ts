/**
 * Stub OpenAI Client 工厂（CLI 集成测试专用）
 *
 * 用途：packages/cli/src/tests/team-cmd-autonomous.test.ts 等 CLI 集成测试通过
 *      TeamCommandArgs.injectedClient 字段注入此 stub，避免在开发机/CI 环境真实调用 LLM
 *
 * 设计依据（遵循用户规则"禁止 mock"）：
 *   - stub client 实现真实 OpenAI 客户端接口契约（chat.completions.create 方法）
 *   - 返回结构化对象（choices + usage），符合 OpenAI Chat Completions API 标准响应格式
 *   - 不是 mock：不模拟内部状态机、不验证调用次数、不动态切换行为
 *   - 是真实接口契约的固定响应，用于依赖注入测试场景
 *
 * 版本演进：
 *   - v1.3（F-03 / 测试专家 B-01）：autonomous 集成测试需要注入 client 避免真实 LLM 调用
 *   - v1.4（G-06 / 产品经理 NB-02）：改为 stage-aware 工厂，根据 system prompt 推断 stage
 *   - v1.5（H-02 + H-07）：stage 推断改为基于 messages[1].content（user prompt）
 *     原因：DevStageHandler 和 FixStageHandler 共用 solo-coder 角色，system prompt 相同，
 *           基于 system prompt 无法区分 dev/fix stage
 *   - v1.6（I-10）：注释修正，原描述"精确字符串匹配"与代码不符（includes 是子串匹配），
 *     改为"基于 stage 标题的长字符串子串匹配，大幅降低误匹配率"
 *   - v1.6（I-12）：stage 标题大小写敏感，必须首字母大写（`# Plan 阶段` 而非 `# plan 阶段`）
 *     原因：JavaScript String.prototype.includes 大小写敏感，小写会匹配失败
 */

import type { OpenAIClientHandle } from "@vegamo/deepcode-core";

/**
 * 构造 stage-aware stub client，根据 user prompt 推断当前 autonomous stage 返回对应 content
 *
 * stage 推断逻辑（v1.5 H-02 修正）：
 *   - 基于 messages[1].content（user prompt）匹配 stage 标题
 *   - BaseStageHandler.buildDescription 生成的 user prompt 含明确的 stage 标题：
 *     `# Plan 阶段` / `# Dev 阶段` / `# Verify 阶段` / `# Fix 阶段`
 *   - 用 stage 标题长字符串子串匹配（替代 v1.4 短关键字子串匹配），
 *     避免 "test" 误匹配 "latest"/"contest"/"testimony" 等
 *
 * 返回 content 与 StageHandler.judgeResult 校验契约对齐：
 *   | Stage  | user prompt 标题       | 返回 content                              | judgeResult 校验                    |
 *   |--------|------------------------|-------------------------------------------|-------------------------------------|
 *   | plan   | `# Plan 阶段`          | `"## Plan\n\n方案内容..."`                | `output.includes("## Plan")` → success |
 *   | dev    | `# Dev 阶段`           | `"## Implementation\n\n```typescript\n..."` | `output.trim().length > 0` → success |
 *   | verify | `# Verify 阶段`        | `"## Test Results\n\nPASS ..."`           | `output.includes("PASS")` → success |
 *   | fix    | `# Fix 阶段`           | `"## Fix\n\n已修复..."`                   | `output.trim().length > 0` → success |
 *   | 默认   | 无匹配                 | `"## Response\n..."`                      | 通用文本，不匹配特定 stage 校验     |
 *
 * @param overrideContent 可选，覆盖 stage 推断逻辑，直接指定返回 content
 *                        使用场景：
 *                          - LL-002 测试 LLM 返回空内容时传 `""`
 *                          - SH-002 测试 PlanStageHandler LLM 未生成方案时传 `""`
 *                          - SH-009 测试 VerifyStageHandler 输出无法解析时传 `"random"`
 *                          - SH-008 测试 VerifyStageHandler 测试失败时传含 "FAIL" 关键字的文本
 *                        注意：SH-010 测试 VerifyStageHandler fatal 分支时不使用本函数，
 *                              改用 buildStubClientAlwaysThrows()
 */
export function buildStubClientReturningValidOutput(overrideContent?: string): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          /**
           * 真实接口契约：接收 messages 数组 + 可选 opts（含 signal）
           * v1.5：根据 user prompt（messages[1].content）推断 stage 返回对应 content
           *
           * @param req 请求体（含 messages 数组）
           * @param _opts 可选参数（含 AbortSignal，stub 不模拟超时，直接忽略）
           * @returns Promise<{ choices, usage }> 符合 OpenAI Chat Completions API 响应格式
           */
          create: async (
            req: { messages: Array<{ role: "system" | "user"; content: string }> },
            _opts?: { signal?: AbortSignal }
          ): Promise<{
            choices: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }> => {
            // 优先使用显式覆盖的 content（测试场景，如 LL-002 传 "" 触发 LLM 返回空内容）
            if (overrideContent !== undefined) {
              return {
                choices: [{ message: { content: overrideContent } }],
                usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
              };
            }

            // v1.5 修正（H-02）：从 user prompt（messages[1].content）推断当前 stage
            //   原因：BaseStageHandler.buildDescription 生成的 user prompt 含明确的
            //         `# Plan 阶段`/`# Dev 阶段`/`# Verify 阶段`/`# Fix 阶段` 标题
            //   优于 system prompt 的关键字：避免 dev/fix 共用 solo-coder 角色导致的歧义
            const userPrompt = req.messages[1]?.content ?? "";

            // v1.5 修正（H-07）：使用基于 stage 标题的长字符串子串匹配
            //   （替代 v1.4 的短关键字子串匹配，大幅降低误匹配率），
            //   避免 "test" 误匹配 "latest"/"contest"/"testimony" 等
            //   v1.6 I-10 修正（测试专家 NB-04 + 架构师 NB-01）：
            //     原描述"精确字符串匹配（非 includes 子串）"与实际代码不符
            //     （String.prototype.includes 本身是子串匹配），同步修正代码注释
            //   v1.6 I-12 修正：stage 标题首字母必须大写，与 BaseStageHandler.buildDescription
            //     生成的 user prompt 保持一致（JavaScript includes 大小写敏感）
            let content: string;
            if (userPrompt.includes("# Plan 阶段")) {
              // PlanStageHandler.judgeResult 检查 output.includes("## Plan")
              content = "## Plan\n\n方案内容：\n1. 分析需求\n2. 设计架构\n3. 编写实现计划\n4. 验证方案可行性";
            } else if (userPrompt.includes("# Dev 阶段")) {
              // DevStageHandler.judgeResult 检查 output.trim().length > 0
              content =
                "## Implementation\n\n```typescript\nexport function login(user: string, pass: string): boolean {\n  // 实现登录逻辑\n  return user.length > 0 && pass.length > 0;\n}\n```";
            } else if (userPrompt.includes("# Verify 阶段")) {
              // VerifyStageHandler.judgeResult 检查 output.includes("PASS") 或 "FAIL"
              content =
                "## Test Results\n\nPASS login.test.ts (3 tests)\nPASS auth.test.ts (5 tests)\n\n✓ 8 tests passed";
            } else if (userPrompt.includes("# Fix 阶段")) {
              // FixStageHandler.judgeResult 检查 output.trim().length > 0
              content = "## Fix\n\n已修复问题：\n- 修正了登录函数的边界条件\n- 添加了空值检查\n- 补充了单元测试";
            } else {
              // 默认返回通用文本（无 stage 标题匹配时，如 system prompt 直接调用）
              content = "## Response\n\n已处理任务，输出内容。";
            }

            return {
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
            };
          },
        },
      },
    },
    // OpenAIClientHandle 必填字段（v1.6 I-07 强化类型守卫后必检）
    model: "stub-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    // stub 不模拟 thinking 模式（Qwen3/DeepSeek-R1 等 reasoning 字段需独立测试）
    thinkingEnabled: false,
  };
}

/**
 * 构造总是抛错的 stub client（用于 AC-004 连续失败 abort / SH-010 fatal 分支测试）
 *
 * 设计：抛出 Error 让 executeDispatch 阶段 3 内部 catch 捕获，
 *      返回 status=failed + error="LLM 调用失败: ..."，
 *      StageHandler.judgeResult 在 status=failed 分支根据 stage 返回不同 kind：
 *        - Plan/Dev/Fix → retriable
 *        - Verify → fatal（test-expert 异常不应重试，需人工介入）
 *
 * @param error 抛出的错误对象（默认 Error("stub error")）
 */
export function buildStubClientAlwaysThrows(error: Error = new Error("stub error")): OpenAIClientHandle {
  return {
    client: {
      chat: {
        completions: {
          /**
           * 总是抛错，模拟 LLM 调用失败场景（网络错误、超时、服务不可用等）
           * executeDispatch 阶段 3 catch 捕获后返回 status=failed
           */
          create: async (): Promise<never> => {
            throw error;
          },
        },
      },
    },
    model: "stub-model",
    baseURL: "https://stub.local",
    temperature: 0.3,
    thinkingEnabled: false,
  };
}
