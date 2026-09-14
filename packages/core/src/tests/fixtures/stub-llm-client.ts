/**
 * EAG-P5 LLM 执行链路测试共享夹具：脚本化桩 LLMClient
 *
 * 边界声明（设计文档 eag-p5-llm-execution-wiring.md §5/§8 风险表）：
 * - 本桩【仅】替换 LLM HTTP 边界：createMessage 按预置脚本返回 LLMResponse，
 *   不发起任何真实网络请求；
 * - 除此之外的一切环节均为生产真实实现：ToolExecutor、read/write/edit 工具、
 *   文件系统落盘、git status、GuardChain、StageHandler、AutonomousOrchestrator；
 * - 桩记录每次请求的完整 messages（含工具结果回灌），供测试断言 fix 阶段
 *   是否真实收到 verify 失败输出片段等消息协议事实；
 * - 脚本耗尽后再次被调用将直接抛错（fail-loud），杜绝"模型静默空转"被误判为成功。
 *
 * @module core/tests/fixtures/stub-llm-client
 */

import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMToolCall,
  LLMUsage,
} from "../../providers/llm-provider";
import type { SessionMessage } from "../../session";

/** 桩记录的单次请求观测事实（脚本断言用） */
export interface StubLlmRequestRecord {
  /** 第几次请求（从 0 开始） */
  readonly index: number;
  /** 当次完整会话消息（引用，测试可读取 tool 回灌内容） */
  readonly messages: ReadonlyArray<SessionMessage>;
  /** 当次暴露给模型的工具名列表（验证白名单收窄） */
  readonly toolNames: ReadonlyArray<string>;
}

/** 一条脚本响应的构造选项 */
export interface StubScriptedResponseOptions {
  /** 终态文本（toolCalls 非空时作为 assistant 文本，可为空串） */
  readonly content?: string;
  /** 工具调用（非空时模型要求执行工具；空数组=终态回复） */
  readonly toolCalls?: ReadonlyArray<{
    readonly name: string;
    /** 工具参数对象，桩内部 JSON.stringify 为 argumentsJson */
    readonly args: Record<string, unknown>;
  }>;
  /**
   * usage 控制：
   * - 缺省/undefined：返回固定非零 usage（模拟正常网关）；
   * - 显式传 null：模拟不回 usage 的网关（触发执行器字符估算保底）；
   * - 传对象：精确指定 input/output token。
   */
  readonly usage?: LLMUsage | null;
  readonly stopReason?: string | null;
}

/**
 * 构造一条脚本响应。
 *
 * @param options 响应选项
 * @param callIdSeed 工具调用 ID 生成种子（配合请求序号保证全局唯一）
 * @returns 归一化 LLMResponse
 */
function buildResponse(options: StubScriptedResponseOptions, callIdSeed: number): LLMResponse {
  const toolCalls: LLMToolCall[] = (options.toolCalls ?? []).map((call, offset) =>
    Object.freeze({
      // call_ 前缀 + 递增序号，保证同一桩多轮内 tool_call_id 唯一可配对
      id: `call_${callIdSeed}_${offset}`,
      name: call.name,
      argumentsJson: JSON.stringify(call.args),
    })
  );
  // usage===undefined 时给固定非零值；===null 时明确返回 null（模拟缺 usage 网关）
  const usage: LLMUsage | null =
    options.usage === undefined ? Object.freeze({ inputTokens: 32, outputTokens: 16 }) : options.usage;
  return Object.freeze({
    content: options.content ?? "",
    thinking: "",
    toolCalls: Object.freeze(toolCalls),
    stopReason: options.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "stop"),
    usage,
  });
}

/** 脚本化桩 LLMClient（实现完整 LLMClient 接口，零网络） */
export class StubLlmClient implements LLMClient {
  readonly providerName = "openai" as const;
  readonly model = "stub-p5-test-model";
  readonly baseURL = "http://127.0.0.1:0/stub";
  readonly supportsThinking = false;
  readonly supportsPromptCaching = false;

  /** 预置响应脚本（按请求次序消费） */
  private readonly script: ReadonlyArray<StubScriptedResponseOptions>;
  /** 请求观测记录（messages/toolNames） */
  private readonly observations: StubLlmRequestRecord[] = [];

  constructor(script: ReadonlyArray<StubScriptedResponseOptions>) {
    this.script = script;
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    const index = this.observations.length;
    // 记录观测事实（在消费脚本前记录，脚本耗尽抛错时仍可追溯最后一次请求）
    this.observations.push(
      Object.freeze({
        index,
        messages: request.messages,
        toolNames: Object.freeze((request.tools ?? []).map((tool) => tool.name)),
      })
    );

    if (index >= this.script.length) {
      // fail-loud：脚本与真实预期不符（例如出现计划外的第三轮 LLM 调用）时立即暴露
      throw new Error(
        `StubLlmClient 脚本已耗尽：第 ${index + 1} 次 createMessage 没有预置响应（脚本长度=${this.script.length}）`
      );
    }
    return buildResponse(this.script[index]!, index);
  }

  createMessageStream(): AsyncIterable<LLMStreamEvent> {
    // 任务执行器设计为仅用非流式 createMessage；流式被触达说明接线错误。
    // 用普通方法返回 rejected Promise（而非 async generator）：调用即抛、
    // 且 for-await 消费该 iterable 时同样抛出，fail-loud 语义不变。
    const reason = new Error("StubLlmClient 不支持 createMessageStream（P5 任务执行器必须使用非流式调用）");
    return {
      [Symbol.asyncIterator](): AsyncIterator<LLMStreamEvent> {
        return {
          next(): Promise<IteratorResult<LLMStreamEvent>> {
            return Promise.reject(reason);
          },
        };
      },
    };
  }

  /** 已发生的请求观测记录（只读副本） */
  getRequests(): ReadonlyArray<StubLlmRequestRecord> {
    return Object.freeze([...this.observations]);
  }

  /** 已发生的请求次数 */
  get requestCount(): number {
    return this.observations.length;
  }
}

/**
 * 便捷工厂：创建脚本化桩与配套的 createLlmClient 工厂。
 *
 * @param script 预置响应序列
 * @returns client 桩实例 + 始终返回该实例的工厂（测试边界：仅替换 HTTP 客户端）
 */
export function createStubLlmClientFactory(script: ReadonlyArray<StubScriptedResponseOptions>): {
  readonly client: StubLlmClient;
  readonly createLlmClient: () => LLMClient;
} {
  const client = new StubLlmClient(script);
  // 生产工厂在无凭据时返回 null；测试工厂始终返回桩（等价于"已配置凭据"的 HTTP 边界替换）
  return Object.freeze({
    client,
    createLlmClient: () => client,
  });
}
