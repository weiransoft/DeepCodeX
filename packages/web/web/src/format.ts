/**
 * 展示格式化工具：时间与文件大小的中文友好显示。
 */

/**
 * 格式化时间戳/时间字符串为友好显示：
 * - 今天：HH:mm；
 * - 今年：MM-DD HH:mm；
 * - 更早：YYYY-MM-DD。
 * @param value ISO 时间串或毫秒时间戳
 * @returns 无法解析时返回原字符串
 */
export function formatTime(value: string | number | undefined): string {
  if (value === undefined) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const sameYear = d.getFullYear() === now.getFullYear();
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  const mo = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  if (sameYear) return `${mo}-${dd} ${hh}:${mm}`;
  return `${d.getFullYear()}-${mo}-${dd}`;
}

/**
 * 文件大小人性化显示（B / KB / MB / GB，保留 1 位小数）。
 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Math.round(v * 10) / 10} ${units[i]}`;
}

/**
 * 判断文件名是否为图片（按扩展名；用于"作为附件插入对话"时决定走 imageUrls 还是文本引用）。
 */
export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name);
}
