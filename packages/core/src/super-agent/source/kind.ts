/**
 * Super Agent 来源（Source）—— 事件流的抽象
 *
 * ## 为什么抽象
 *
 * DSH 原型为 GitHub 与飞书写了两套专用实现。DeepCodeX 首期只需要
 * 「本地文件变更」与「MCP 通知」两个来源，但**来源是可插拔的**——
 * 抽象出来之后，加 GitHub / 企微 / 邮件不需要改引擎。
 *
 * ## Source 的三条约束
 *
 * 1. **持有读游标**——重启不得重放事件。
 * 2. **丢弃自身消息**——机器人自己说的话不能触发自己。
 * 3. **只拥有自己的数据**——改变领域状态只能经由引擎的 Source 视图（I3）。
 *
 * @module super-agent/source/kind
 */

import type { NewTrigger } from "../domain/types.js";

/** Source 配置（每个 kind 自定义） */
export type SourceConfig = Readonly<Record<string, unknown>>;

/** 投递事件的回调 */
export type TriggerSink = (trigger: NewTrigger, threadKeys: readonly string[]) => void;

/** Source 实例 */
export interface SourceInstance {
  /** 实例 ID（稳定，跨重启不变） */
  readonly id: string;
  /** 开始监听 */
  start(): Promise<void>;
  /** 停止监听 */
  stop(): Promise<void>;
}

/** Source 配置项声明（用于 CLI 展示与校验） */
export interface SourceField {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly required: boolean;
}

/**
 * SourceKind —— 一类可复用的来源实现
 */
export interface SourceKind {
  /** kind 标识 */
  readonly id: string;
  /** 人类可读标题 */
  readonly title: string;
  /** 说明 */
  readonly description: string;
  /** 配置项声明 */
  readonly fields: readonly SourceField[];
  /**
   * 创建实例
   *
   * @param options 创建参数
   * @returns Source 实例
   */
  create(options: {
    readonly sourceId: string;
    readonly config: SourceConfig;
    readonly sink: TriggerSink;
  }): SourceInstance;
}

/**
 * SourceRegistry —— Source 实例的注册表
 *
 * 负责：注册 kind、持有实例、启动/停止全部实例。
 */
export class SourceRegistry {
  /** 已注册的 kind */
  private readonly kinds = new Map<string, SourceKind>();
  /** 已创建的实例 */
  private readonly instances = new Map<string, SourceInstance>();

  /**
   * 注册一个 kind
   *
   * @param kind Source kind
   */
  registerKind(kind: SourceKind): void {
    if (this.kinds.has(kind.id)) {
      throw new Error(`Source kind ${kind.id} 已注册。`);
    }
    this.kinds.set(kind.id, kind);
  }

  /**
   * 创建一个实例
   *
   * @param kindId kind ID
   * @param sourceId 实例 ID
   * @param config 配置
   * @param sink 投递回调
   * @returns Source 实例
   */
  create(kindId: string, sourceId: string, config: SourceConfig, sink: TriggerSink): SourceInstance {
    const kind = this.kinds.get(kindId);
    if (kind === undefined) {
      throw new Error(`未注册的 Source kind：${kindId}`);
    }
    const instance = kind.create({ sourceId, config, sink });
    this.instances.set(sourceId, instance);
    return instance;
  }

  /** 启动全部实例 */
  async startAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      await instance.start();
    }
  }

  /** 停止全部实例 */
  async stopAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      await instance.stop();
    }
  }

  /** 列出已注册的 kind */
  listKinds(): readonly SourceKind[] {
    return [...this.kinds.values()];
  }

  /** 列出已创建的实例 */
  listInstances(): readonly SourceInstance[] {
    return [...this.instances.values()];
  }
}
