/**
 * Windows 文件路径规则校验
 *
 * 背景：POSIX 上"路径能不能用"由文件系统自己判定（非法字符只有 / 和 NUL），
 * 所以文件工具历来不做路径合法性检查。Windows 不一样，有几类路径会静默走偏：
 *
 *   1. 保留设备名（CON / NUL / COM1 …）
 *      `C:\work\CON` 不是文件，是"控制台设备"。写入会打到控制台，读取会阻塞等待输入。
 *      这类名字在 NTFS 上属于合法文件名，Node 不会报错，只会把 IO 引到设备上。
 *   2. 尾随点/空格
 *      `foo.` 与 `foo ` 会被 Win32 静默裁剪成 `foo`，结果写到了另一处。
 *   3. 非法字符 < > : " | ? *
 *      直接 EINVAL，但报错信息对模型毫无信息量。
 *   4. MAX_PATH 260
 *      超长路径在未开启 LongPathsEnabled 的机器上是 ENOENT，看起来像"目录不存在"。
 *
 * 本模块只做判定，不做清洗：拿到问题后由调用方决定拒绝并给出可执行的修复建议。
 * 平台可注入，便于在 macOS/Linux 上验证 win32 语义。
 */

/** Win32 传统路径长度上限（含结尾 NUL，故实际可用 259） */
export const WINDOWS_MAX_PATH = 260;

/**
 * 保留设备名（大小写不敏感，且与扩展名无关：`CON.txt` 同样是设备）
 *
 * 来源：Microsoft "Naming Files, Paths, and Namespaces" — Win32 保留名列表。
 * 上标数字形式（COM¹ / LPT²）也被系统识别为设备，一并拦截。
 */
export const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  "CONIN$",
  "CONOUT$",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "COM\u00b9",
  "COM\u00b2",
  "COM\u00b3",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "LPT\u00b9",
  "LPT\u00b2",
  "LPT\u00b3",
]);

/** 扩展长度前缀 `\\?\`：启用后跳过绝大多数 Win32 路径规范化（含 MAX_PATH） */
const EXTENDED_LENGTH_PREFIX_RE = /^\\\\\?\\/;

/** 设备命名空间前缀 `\\.\`：指向驱动/设备而非文件 */
const DEVICE_NAMESPACE_PREFIX_RE = /^\\\\\.\\/;

/** 仅盘符、无路径分隔符的段（`C:`），不能当普通文件名段校验 */
const DRIVE_PREFIX_ONLY_RE = /^[A-Za-z]:$/;

/** Windows 文件名禁止字符（`:` 仅允许出现在盘符位置） */
const INVALID_CHARACTER_RE = /[<>:"|?*]/;

/** 控制字符（0x00-0x1F）在 Windows 文件名中一律非法 */
const CONTROL_CHARACTER_RE = /[\u0000-\u001f]/;

export type WindowsPathIssueCode =
  | "device-namespace"
  | "reserved-device-name"
  | "invalid-character"
  | "trailing-dot-or-space"
  | "path-too-long";

export type WindowsPathIssue = {
  /** 问题分类（便于日志聚合与测试断言） */
  code: WindowsPathIssueCode;
  /** 出问题的路径段（整路径级问题时为 undefined） */
  segment?: string;
  /** 面向调用方的英文说明，含修复建议 */
  message: string;
};

export type WindowsPathRuleOptions = {
  /** 目标平台，默认当前平台；注入 "win32" 可在 POSIX 上验证 Windows 语义 */
  platform?: NodeJS.Platform;
  /** 路径长度上限，默认 WINDOWS_MAX_PATH */
  maxPath?: number;
};

/**
 * 判定一个路径在 Windows 上能否安全用作文件路径
 *
 * @param filePath 待检查路径
 * @param options 平台与长度上限覆盖
 * @returns 首个问题；无问题或非 Windows 平台返回 null
 */
export function findWindowsPathIssue(filePath: string, options: WindowsPathRuleOptions = {}): WindowsPathIssue | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return null;
  }
  if (typeof filePath !== "string" || filePath.length === 0) {
    return null;
  }
  const maxPath = options.maxPath ?? WINDOWS_MAX_PATH;

  // `\\.\` 直接指向设备（\\.\PhysicalDrive0、\\.\C:），任何文件操作语义都不成立
  if (DEVICE_NAMESPACE_PREFIX_RE.test(filePath)) {
    return {
      code: "device-namespace",
      message: "file_path uses the \\\\.\\ device namespace, which addresses hardware devices rather than files.",
    };
  }

  const isExtendedLength = EXTENDED_LENGTH_PREFIX_RE.test(filePath);
  const body = isExtendedLength ? filePath.slice(4) : filePath;
  const segments = body.replace(/\//g, "\\").split("\\");

  for (const segment of segments) {
    // 空段（根/连续分隔符）、`.`、`..` 均为结构段，不是文件名
    if (segment === "" || segment === "." || segment === "..") {
      continue;
    }
    // `C:` 盘符段
    if (DRIVE_PREFIX_ONLY_RE.test(segment)) {
      continue;
    }

    // 保留设备名：取第一个点之前的部分，并去掉尾部空格（Win32 会忽略尾随空格）
    const stem = segment.split(".")[0]!.replace(/ +$/, "").toUpperCase();
    if (stem.length > 0 && WINDOWS_RESERVED_DEVICE_NAMES.has(stem)) {
      return {
        code: "reserved-device-name",
        segment,
        message:
          `"${segment}" resolves to the reserved Windows device "${stem}" instead of a file ` +
          `(writing to it goes to the device, reading from it can block). ` +
          `Rename it, e.g. "${stem}_file".`,
      };
    }

    if (CONTROL_CHARACTER_RE.test(segment) || INVALID_CHARACTER_RE.test(segment)) {
      return {
        code: "invalid-character",
        segment,
        message: `"${segment}" contains characters Windows forbids in file names (< > : " | ? * or control characters).`,
      };
    }

    if (/[ .]$/.test(segment)) {
      return {
        code: "trailing-dot-or-space",
        segment,
        message:
          `"${segment}" ends with a dot or a space, which Win32 silently strips, ` +
          `so the path would resolve to a different name.`,
      };
    }
  }

  // 长度检查：显式使用 `\\?\` 前缀即视为用户主动启用长路径，跳过限制
  if (!isExtendedLength && filePath.length >= maxPath) {
    return {
      code: "path-too-long",
      message:
        `path is ${filePath.length} characters, exceeding the Windows MAX_PATH limit of ${maxPath - 1}. ` +
        `Shorten the path, or prefix it with \\\\?\\ to opt into extended-length paths.`,
    };
  }

  return null;
}

/**
 * 文件工具用的一行式校验：返回可直接作为工具 error 输出的说明，或 null
 *
 * 与 findWindowsPathIssue 分开的原因：工具层需要"一句话 + 分类前缀"，
 * 内部逻辑需要结构化结果做断言。
 */
export function validateWindowsFileToolPath(filePath: string, options: WindowsPathRuleOptions = {}): string | null {
  const issue = findWindowsPathIssue(filePath, options);
  if (!issue) {
    return null;
  }
  return `[${issue.code}] ${issue.message}`;
}
