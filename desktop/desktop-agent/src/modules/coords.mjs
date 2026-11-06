/**
 * 坐标帧（coordinate frame）—— 视觉兜底唯一的坐标系换算点。
 *
 * 为什么必须有这一层：视觉兜底时调用方（模型/脚本）的坐标**来自截图**，
 * 它不是屏幕坐标，差在两点上：
 *   1. **原点**：截图取的是目标窗口矩形，图像 (0,0) 是窗口左上角，不是屏幕 (0,0)。
 *      拿图像坐标直接点，实际落点整体偏移一个窗口原点的距离。
 *   2. **缩放**：高 DPI 下截图像素数与 UIA/输入 API 使用的坐标单位不一致
 *      （同一块区域，截图 1250 px、UIA 矩形 1000 px），差一个 scale。
 *
 * 这两点叠起来的后果不是「点不准」，而是「点到别的窗口上」——R4 不可逆误动作。
 * 因此：图像坐标 → 屏幕坐标只在 `resolveClickPoint` 里换算，**越界一律拒绝**，
 * 宁可这一次不点，也不猜。
 *
 * 反向也成立：`snapToNearestElement` 与树的 `rect` 都在屏幕坐标系，所以吸附必须
 * 发生在换算之后（先换算、再吸附、最后复核边界），顺序写错就会吸附到错误元素。
 */

import { ErrorCode, AgentError } from "../errors.mjs";

/**
 * 从一次截图结果里取出坐标帧。
 * 桥侧 `screenshot` 回传 `rect`（屏幕坐标下的窗口矩形）与 `width/height`（图像像素），
 * 两者相除就是这次截图的缩放比——不用去问 DPI，问也未必一致（进程可能是
 * DPI-unaware，被系统虚拟化过）。
 *
 * @param {{rect?:{x:number,y:number,width:number,height:number},width?:number,height?:number}} shot
 * @returns {{x:number,y:number,width:number,height:number,imageWidth:number,imageHeight:number,scaleX:number,scaleY:number}|null}
 */
export function frameFromShot(shot) {
  // 已经算过的帧原样返回：上层把帧缓存下来（比如跟着截图存）再传回来是常态，
  // 让它自己再推导一遍容易把「帧」和「截图结果」两种形态搞混。
  if (shot && Number.isFinite(shot.scaleX) && Number.isFinite(shot.scaleY) && shot.width > 0) {
    return shot;
  }
  const r = shot?.rect;
  if (!r) return null;
  const w = Number(r.width);
  const h = Number(r.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const iw = Number(shot?.width) > 0 ? Number(shot.width) : w;
  const ih = Number(shot?.height) > 0 ? Number(shot.height) : h;
  return {
    x: Number(r.x) || 0,
    y: Number(r.y) || 0,
    width: w,
    height: h,
    imageWidth: iw,
    imageHeight: ih,
    // scaleX 是「一个屏幕单位对应几个图像像素」；反算时除它
    scaleX: iw / w,
    scaleY: ih / h,
  };
}

/** 点是否落在帧矩形内（tolerance 单位同帧的屏幕坐标） */
export function frameContains(frame, x, y, tolerance = 2) {
  if (!frame) return false;
  return (
    x >= frame.x - tolerance &&
    x <= frame.x + frame.width + tolerance &&
    y >= frame.y - tolerance &&
    y <= frame.y + frame.height + tolerance
  );
}

/**
 * 把调用方给的坐标换算成屏幕坐标，并做越界复核。
 *
 * `frame` 取值：
 * - `"window"`（默认）：x/y 是**截图图像像素**，相对窗口左上角。这是视觉兜底的自然产物。
 * - `"screen"`：x/y 已是屏幕坐标（例如从上一次 `snapshot` 的 rect 直接推出来的）。
 *
 * `allowOutside`：菜单/右键弹出层常常落在主窗口矩形之外，这类目标需要显式放行；
 * 默认 false，因为「点在窗口外」在绝大多数情况下是把坐标搞错了。
 *
 * @throws {AgentError} OBSERVATION_FAILED（window 模式但没有可用帧）
 * @throws {AgentError} ACTION_DENIED（换算后越界且未放行）
 */
export function resolveClickPoint({ x, y, frame = "window", shot = null, tolerance = 2, allowOutside = false } = {}) {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    throw new AgentError(ErrorCode.INVALID_ARGUMENT, `坐标必须是有限数值：(${x}, ${y})`);
  }
  if (frame !== "window" && frame !== "screen") {
    throw new AgentError(ErrorCode.INVALID_ARGUMENT, `frame 只能是 window / screen，收到 ${frame}`);
  }

  const f = frameFromShot(shot);

  if (frame === "window") {
    if (!f) {
      throw new AgentError(
        ErrorCode.OBSERVATION_FAILED,
        "按窗口坐标点击前必须先截图：没有矩形就不知道窗口左上角在哪，算不出屏幕坐标",
        {
          hint: "先 desktop_screenshot 拿到 rect，再用图像像素坐标调用；或改用 frame:\"screen\" 直接给屏幕坐标",
          recoverable: true,
        }
      );
    }
    const sx = f.x + px / f.scaleX;
    const sy = f.y + py / f.scaleY;
    if (!allowOutside && !frameContains(f, sx, sy, tolerance)) {
      throw outOfBounds({ sx, sy, f, requested: { x: px, y: py, frame } });
    }
    return {
      x: sx,
      y: sy,
      frame: "window",
      converted: true,
      scaleX: f.scaleX,
      scaleY: f.scaleY,
      windowRect: f,
      boundsChecked: true,
    };
  }

  // frame === "screen"：不再换算，但只要知道窗口矩形就同样复核——
  // 「点在窗口外」几乎总是坐标搞错，而不是真的要往桌面点一下。
  if (!allowOutside && f && !frameContains(f, px, py, tolerance)) {
    throw outOfBounds({ sx: px, sy: py, f, requested: { x: px, y: py, frame } });
  }
  return {
    x: px,
    y: py,
    frame: "screen",
    converted: false,
    scaleX: f?.scaleX ?? 1,
    scaleY: f?.scaleY ?? 1,
    windowRect: f,
    boundsChecked: Boolean(f),
  };
}

function outOfBounds({ sx, sy, f, requested }) {
  return new AgentError(
    ErrorCode.ACTION_DENIED,
    `坐标 (${Math.round(sx)}, ${Math.round(sy)}) 落在目标窗口外（窗口 ${f.x},${f.y} ${f.width}×${f.height}），拒绝点击以免打到其它窗口`,
    {
      hint: "确认用的是最近一次截图；弹出菜单等确实在窗口外的目标需显式 allowOutside",
      requested,
      resolved: { x: Math.round(sx), y: Math.round(sy) },
      windowRect: { x: f.x, y: f.y, width: f.width, height: f.height },
    }
  );
}
