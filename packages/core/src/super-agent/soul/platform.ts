/**
 * 语音能力的平台默认值
 *
 * ## 为什么语音默认值要跟平台走
 *
 * 语音链路依赖**本机**的 MLX sidecar（`mlx_whisper` / `mlx_audio`），这两个包
 * 只有 Apple Silicon 的 Metal 后端能跑。Windows 上装不起来——把「启用语音」
 * 默认打开，用户得到的只是一个永远不可达的入口：点下去要等到超时才被告知
 * 「sidecar 未就绪」。**一个默认值不该制造一次注定失败的等待。**
 *
 * 所以：有本地语音模型的平台默认打开，没有的默认关闭（入口也不出现）。
 *
 * ## 为什么判定放在服务端
 *
 * desktop 版的服务端与客户端同机，`process.platform` 就是用户的操作系统。
 * 放到浏览器判断（UA 嗅探）反而会在 Web 部署场景下判错：用户拿 Windows
 * 浏览器访问 Linux 服务器时，"谁没有模型" 取决于服务器，不是浏览器。
 *
 * ## 为什么 Linux 也算「没有」
 *
 * MLX 是 Apple 的框架，Linux 上没有对应实现。理论上可以换
 * faster-whisper + piper 拼一条，但那是另一条链路，当前 sidecar 只认 MLX。
 * 等真做了再往这里加平台，别提前把默认值放开。
 *
 * ## 这套默认值只影响「没配过的人」
 *
 * 显式写过 `enabled: true/false` 的配置一律尊重原值（见
 * `normalizeVoiceConfig`）——升级不该把用户手动关掉的语音又打开。
 * 也就是说：新装、或旧配置里压根没有这个字段，才吃平台默认。
 *
 * @module super-agent/soul/platform
 */

/**
 * 该平台是否具备本机语音交互能力
 *
 * @param platform Node 的 `process.platform` 取值（可注入，便于测试）
 * @returns 是否有本地语音模型可用
 */
export function isVoiceCapablePlatform(platform: string = process.platform): boolean {
  return platform === "darwin";
}

/**
 * 语音总开关的默认值
 *
 * @param platform 平台标识
 * @returns 默认是否启用语音
 */
export function defaultVoiceEnabled(platform: string = process.platform): boolean {
  return isVoiceCapablePlatform(platform);
}

/**
 * 自动朗读的默认值
 *
 * 与总开关同源：没有合成能力时「自动朗读」这个选项本身没有意义，
 * 默认打开只会让设置页出现一个点了没反应的开关。
 *
 * @param platform 平台标识
 * @returns 默认是否自动朗读
 */
export function defaultSpeakReplies(platform: string = process.platform): boolean {
  return isVoiceCapablePlatform(platform);
}
