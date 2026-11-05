/**
 * 配置变更广播：让设置页的改动立刻影响输入框那侧的语音能力
 *
 * ## 为什么需要它
 *
 * `useSoulConfig` / `useVoiceTalk` 在页面加载时读一次配置就不再读。
 * 这在改头像、改音色时没感觉（下次刷新就对了），但**改语音开关、改唤醒开关
 * 必须立刻生效**：
 *
 * - 打开「语音唤醒」却没反应，用户会以为麦克风已经在听——实际上没有；
 * - 关掉语音却还在播报，用户会以为开关坏了。
 *
 * 两种情况都是「界面说的」和「实际做的」不一致，比功能缺失更糟。
 *
 * ## 为什么不用 Context / 全局状态
 *
 * 与 `preference.ts` 同一套思路：设置页写、输入框听，两端隔了好几层组件，
 * 为一个配置刷新包一层 Provider 不划算。自定义事件 + `storage` 事件兜住跨标签页。
 *
 * @module web/voice/config-events
 */

/** 配置已变更的事件名 */
export const SOUL_CONFIG_EVENT = "dcx:soul-config-changed";

/** 通知「配置已变更」（保存成功后调用） */
export function notifySoulConfigChanged(): void {
  try {
    globalThis.dispatchEvent?.(new CustomEvent(SOUL_CONFIG_EVENT));
  } catch {
    // 无 window（测试环境）时忽略
  }
}

/**
 * 订阅配置变更
 *
 * @param handler 变更回调（通常是重新拉一次配置）
 * @returns 取消订阅
 */
export function subscribeSoulConfigChanged(handler: () => void): () => void {
  const listener = (): void => handler();
  globalThis.addEventListener?.(SOUL_CONFIG_EVENT, listener);
  return () => {
    globalThis.removeEventListener?.(SOUL_CONFIG_EVENT, listener);
  };
}
