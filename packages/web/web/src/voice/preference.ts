/**
 * 语音偏好：免按住开关的单一来源
 *
 * ## 为什么不用服务端配置
 *
 * 「点一下说话」是**这台设备上的交互习惯**，不是人格设定：手机想免按住、
 * 坐在嘈杂工位想按住说话，换台机器就该有不同的默认。放 localStorage，
 * 跟着浏览器走；放 `~/.deepcode/soul/config.json` 反而会让另一台机器莫名其妙。
 *
 * ## 为什么要有事件
 *
 * 开关在设置面板，生效在输入框，两个组件各自持有一个 `useVoiceTalk`/状态。
 * 不给它们建 provider（为一个小开关包一层 Context 不划算），改用
 * 「写 localStorage + 派发一个自定义事件」：面板写，输入区订阅。同页内即时生效，
 * 跨标签页再由 `storage` 事件兜住。
 *
 * @module web/voice/preference
 */

import type { EndpointProfile } from "./endpointing";

/** 存储键 */
export const HANDS_FREE_KEY = "dcx.voice.handsFree";

/** 同页内广播的事件名 */
export const HANDS_FREE_EVENT = "dcx:voice-hands-free";

/**
 * 客户端是否 Apple 平台
 *
 * 只看 UA，不问服务端：这个默认值是**设备上的交互习惯**，跟服务端跑在
 * 哪台机器无关。desktop 版两者同机，结论一致；Web 版也不该因为服务器
 * 是 Linux 就把 Mac 用户的免按住关掉。
 *
 * @returns 是否 Apple 设备（Mac / iPad，iPad 的 UA 也含 Macintosh）
 */
export function isAppleClient(): boolean {
  try {
    const ua = globalThis.navigator?.userAgent ?? "";
    return /Macintosh|Mac OS X|iPhone|iPad/.test(ua);
  } catch {
    return false;
  }
}

/**
 * 免按住的平台默认值
 *
 * Mac 默认开、Windows 默认关——与语音总开关同一条判断：
 * 没有本地语音模型时这个开关调了也没有意义。
 *
 * @returns 默认是否免按住
 */
export function defaultHandsFree(): boolean {
  return isAppleClient();
}

/**
 * 读取免按住偏好
 *
 * @param fallback 存储不可用时的默认值（默认按平台）
 * @returns 是否免按住
 */
export function readHandsFree(fallback = defaultHandsFree()): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(HANDS_FREE_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // 隐私模式/无 localStorage：用默认值
  }
  return fallback;
}

/**
 * 写入免按住偏好并广播
 *
 * @param value 是否免按住
 */
export function writeHandsFree(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(HANDS_FREE_KEY, value ? "1" : "0");
  } catch {
    // 存不下就只在本页生效
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(HANDS_FREE_EVENT, { detail: value }));
  } catch {
    // 无 window（测试环境）时忽略
  }
}

/**
 * 订阅免按住变化（同页事件 + 跨标签页 storage 事件）
 *
 * @param handler 变化回调
 * @returns 取消订阅
 */
export function subscribeHandsFree(handler: (value: boolean) => void): () => void {
  const onCustom = (event: Event): void => {
    handler((event as CustomEvent<boolean>).detail === true);
  };
  const onStorage = (event: Event): void => {
    const key = (event as StorageEvent).key;
    if (key === null || key === HANDS_FREE_KEY) handler(readHandsFree());
  };
  globalThis.addEventListener?.(HANDS_FREE_EVENT, onCustom);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    globalThis.removeEventListener?.(HANDS_FREE_EVENT, onCustom);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/*
 * 流式播放开关
 *
 * 同样是「这台设备上的偏好」而不是人格设定，所以跟着 localStorage 走。
 *
 * **默认开**（2026-11-06 第二轮）。流式首字延迟实测 3.59s → 0.41s（约 8.7×）。
 * 上一轮之所以临时关掉，是因为 `speed != 1.0` 时服务端对每个 0.8s chunk
 * 独立做一次 WSOLA 保调变速，而 WSOLA 是重叠相加算法、状态不能跨块延续：
 * 块边界样本跳变中位 2.8%/最大 19.4%（speed=1.0 只有 0.1%/1.2%），听感是
 * 「前后两句语速不一样」「讲了几句中间像断了一下」。
 *
 * 现在服务端 `StreamingWsola` 让整个请求共用一条变速时间轴，分块喂入与整段
 * 一次变速**逐样本相等**（`test_streaming_wsola.py` 锁住），边界不再重启窗
 * 函数。根因消除，默认切回流式；整块链路仍作为用户手动关闭时的回退。
 *
 * ## 为什么换存储键
 *
 * 上一版默认关，可能有人手动关过、留下 `"0"`。这次是**修复后重新默认开**，
 * 不该让旧版本的实验性选择继续压着新默认值，所以升到 `.v2`：读到旧键就
 * 一次性删掉并采用新默认。用户之后手动关会写 v2 的 `"0"`，仍会被尊重。
 */
export const STREAM_PLAYBACK_KEY = "dcx.voice.streamPlayback.v2";
/** 上一版（逐块独立变速）的键：升级时一次性清理，不继承值 */
const LEGACY_STREAM_PLAYBACK_KEY = "dcx.voice.streamPlayback";
export const STREAM_PLAYBACK_EVENT = "dcx:voice-stream-playback";

/** 流式播放默认值：开（跨 chunk 有状态 WSOLA 已消除边界失真） */
export function defaultStreamPlayback(): boolean {
  return true;
}

/**
 * 读取流式播放偏好
 *
 * @param fallback 存储不可用时的默认值
 * @returns 是否启用流式播放
 */
export function readStreamPlayback(fallback = defaultStreamPlayback()): boolean {
  try {
    const store = globalThis.localStorage;
    const raw = store?.getItem(STREAM_PLAYBACK_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
    // 没有 v2 值 = 升级后的第一次读取。旧键是上一版「逐块独立变速」时代
    // 留下的实验性开关，不继承（见文件头说明），清掉后回到新的默认开。
    store?.removeItem(LEGACY_STREAM_PLAYBACK_KEY);
  } catch {
    // 隐私模式/无 localStorage：用默认值
  }
  return fallback;
}

/** 写入流式播放偏好并广播 */
export function writeStreamPlayback(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(STREAM_PLAYBACK_KEY, value ? "1" : "0");
  } catch {
    // 存不下就只在本页生效
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(STREAM_PLAYBACK_EVENT, { detail: value }));
  } catch {
    // 无 window（测试环境）时忽略
  }
}

/*
 * 轮次判停档位与回馈语 HOLD
 *
 * 两者都是「这台设备上的交互习惯」，跟着 localStorage 走。
 *
 * 判停档位默认 `adaptive`：把正常一句话的静默窗从 900ms 压到 600ms，
 * 短语与长叙述仍保持 900ms。这是**保守**优化 —— 没有流式 ASR 就没有
 * 语义判停，只能按已说时长做近似，所以不碰最容易误切的两类边缘情况。
 * `legacy` 是完整回滚开关，`fast`（350ms）留给真机 A/B，默认不启用。
 *
 * 回馈语 HOLD 默认**关**：它要额外观察 200ms 才能区分「嗯」和真实插话，
 * 会把打断延迟从 300ms 抬到 500ms。误打断更伤体验，但代价必须让用户
 * 自己听完再决定，不能替他默认打开（2026-11-07 诚实降级原则）。
 */
export const ENDPOINT_PROFILE_KEY = "dcx.voice.endpointProfile.v1";
export const BACKCHANNEL_HOLD_KEY = "dcx.voice.backchannelHold.v1";

/** 判停档位默认值：保守自适应 */
export function defaultEndpointProfile(): EndpointProfile {
  return "adaptive";
}

/** 读取判停档位；非法值回落到默认，不让坏配置把端点判定卡死 */
export function readEndpointProfile(): EndpointProfile {
  try {
    const raw = globalThis.localStorage?.getItem(ENDPOINT_PROFILE_KEY);
    if (raw === "legacy" || raw === "adaptive" || raw === "fast") return raw;
  } catch {
    // 隐私模式/无 localStorage：用默认值
  }
  return defaultEndpointProfile();
}

/** 写入判停档位（下一次开录生效） */
export function writeEndpointProfile(value: EndpointProfile): void {
  try {
    globalThis.localStorage?.setItem(ENDPOINT_PROFILE_KEY, value);
  } catch {
    // 存不下就只在本页生效
  }
}

/** 读取回馈语 HOLD 开关（默认关） */
export function readBackchannelHold(): boolean {
  try {
    return globalThis.localStorage?.getItem(BACKCHANNEL_HOLD_KEY) === "1";
  } catch {
    return false;
  }
}

/** 写入回馈语 HOLD 开关 */
export function writeBackchannelHold(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(BACKCHANNEL_HOLD_KEY, value ? "1" : "0");
  } catch {
    // 存不下就只在本页生效
  }
}

/*
 * 结构感知分块（2026-11-07 P0，默认关）
 *
 * 前端别把 `{...}` / URL / 拉丁词 / 数字串切碎，服务端 TNS 才有机会看到
 * 完整结构。真机 A/B：`code:xl` 块间语速极差 43.71% → 6.84%（阈值 ≤8%）。
 * 但这是「探针复刻前端切分 + 直连 sidecar」的证据，桌面 WebView 真机听感
 * 仍需人工确认，所以**不默认打开**：改偏好或设环境变量后重启才能灰度。
 * 服务端另有 `DCX_VOICE_ATOMIC_CHUNK`，两侧独立，可分别回退。
 */
export const ATOMIC_CHUNK_KEY = "dcx.voice.atomicChunk.v1";

/** 读取结构感知分块开关（默认关） */
export function readAtomicChunk(): boolean {
  try {
    return globalThis.localStorage?.getItem(ATOMIC_CHUNK_KEY) === "1";
  } catch {
    return false;
  }
}

/** 写入结构感知分块开关（下一次开录生效） */
export function writeAtomicChunk(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(ATOMIC_CHUNK_KEY, value ? "1" : "0");
  } catch {
    // 存不下就只在本页生效
  }
}

/**
 * 稳态分块（第十四轮，2026-11-11）——**默认关的灰度项**
 *
 * 真机逐块音色指纹 A/B 结果是**双向的**，不足以支撑改默认：
 *  - 纯中文：#1↔#2 联合距离 8.18→3.91（−52%）、频带 8.597→5.015dB，
 *    但差异被搬到 #2↔#3（频带 3.21→8.032dB），频带均值 4.506→5.017 变差；
 *  - 中英混排：全块下限后联合均值 6.021→6.69、频带 7.439→8.48，整体退化。
 *
 * 因此只作为可试听、可回退的灰度开关：把 `dcx.voice.steadyBlocks.v1`
 * 写成 `"1"` 开启，删除或写 `"0"` 回到第十四轮之前的 v13 行为。
 * 对比音频见 `scripts/voice/README.md` 第十四轮。
 */
export const STEADY_BLOCKS_KEY = "dcx.voice.steadyBlocks.v1";

/** 读取稳态分块开关（默认关，显式 "1" 才开启） */
export function readSteadyBlocks(): boolean {
  try {
    return globalThis.localStorage?.getItem(STEADY_BLOCKS_KEY) === "1";
  } catch {
    return false;
  }
}

/** 写入稳态分块开关（下一次开录生效） */
export function writeSteadyBlocks(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(STEADY_BLOCKS_KEY, value ? "1" : "0");
  } catch {
    // 存不下就只在本页生效
  }
}

/** 订阅流式播放变化（同页事件 + 跨标签页 storage 事件） */
export function subscribeStreamPlayback(handler: (value: boolean) => void): () => void {
  const onCustom = (event: Event): void => {
    handler((event as CustomEvent<boolean>).detail === true);
  };
  const onStorage = (event: Event): void => {
    const key = (event as StorageEvent).key;
    // 旧键被清理时也会跨标签页广播，顺带让那一页重读一次新默认值
    if (key === null || key === STREAM_PLAYBACK_KEY || key === LEGACY_STREAM_PLAYBACK_KEY) {
      handler(readStreamPlayback());
    }
  };
  globalThis.addEventListener?.(STREAM_PLAYBACK_EVENT, onCustom);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    globalThis.removeEventListener?.(STREAM_PLAYBACK_EVENT, onCustom);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
