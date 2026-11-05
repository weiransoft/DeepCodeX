/**
 * 本轮语音指令快照
 *
 * ## 它修的是什么
 *
 * 语音指令（回复首行的 `{"voice":...,"speed":...,"once":true}`）本意是
 * 「这一条回复怎么念」。但播报队列是**惰性合成 + 预取一句**：流结束时
 * 队列里通常还有一两句没送去合成。原先的实现是在流结束（`finishFeed`）
 * 就把 `once` 指令清掉，于是那几句退回服务端默认音色与语速——
 * **同一条回复前半段御姐音、后半段换个人**，这就是「音色语速前后不一致」。
 *
 * ## 为什么用「下一轮开始」而不是「队列播完」作为重置时机
 *
 * 流式播报时队列会中途排空（合成快于生成），那一刻并不代表回复结束。
 * 把重置绑在「队列空」上，长回复会在中途被切成两种音色。
 * 真正干净的边界是**下一条回复开始**：那时本轮的全部句子必然已入队。
 *
 * ## 两层状态的分工
 *
 * - `base`：跨轮默认。带 `once` 的指令在轮末失效；不带 `once` 的会成为
 *   后续回复的默认音色/语速（这是指令设计的一部分）。
 * - `turn`：本轮快照。合成函数只读它，保证本轮每一句参数一致。
 *
 * @module web/voice/turn-directive
 */

import type { VoiceDirective } from "./directive";

/**
 * 本轮指令状态机
 */
export class TurnDirective {
  /** 跨轮默认（once 的在轮末清掉） */
  private base: VoiceDirective | null = null;
  /** 本轮快照（合成函数读这个） */
  private turn: VoiceDirective | null = null;

  /**
   * 新一轮开始：把跨轮默认冻结成本轮快照
   *
   * 上一轮的 once 指令在这里自然失效——本方法读到的是已被 `endTurn`
   * 清理过的 `base`。
   */
  beginTurn(): void {
    this.turn = this.base;
  }

  /**
   * 收到一条指令：立即生效于本轮
   *
   * `once` 的指令**不动跨轮默认**——它只描述"这一条怎么念"。如果连默认一起
   * 覆盖，用户上一轮设好的音色会在某个回复说了句「慢点说」之后被悄悄改掉。
   *
   * @param directive 已校验的指令
   */
  apply(directive: VoiceDirective): void {
    this.turn = directive;
    if (directive.once !== true) {
      this.base = directive;
    }
  }

  /**
   * 本轮还剩几句要合成时读取的参数
   *
   * @returns 当前生效的指令（无指令时为 null，表示走服务端配置）
   */
  current(): VoiceDirective | null {
    return this.turn;
  }

  /**
   * 本轮结束（流收尾）
   *
   * **只清跨轮默认，不动本轮快照**——队列里没合成完的句子还要用它。
   */
  endTurn(): void {
    if (this.base?.once === true) this.base = null;
  }
}
