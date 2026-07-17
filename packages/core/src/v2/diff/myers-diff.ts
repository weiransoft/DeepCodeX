/**
 * Myers diff 算法实现
 *
 * 基于 Eugene W. Myers 的论文 "An O(ND) Difference Algorithm and Its Variations"
 * (1986)，实现最短编辑脚本（Shortest Edit Script, SES）的计算。
 *
 * 核心思想：
 * - 将 diff 问题转化为图搜索：从 (0,0) 到 (N,M) 的最短路径
 * - 每一步可以是：向右（delete a[i]）、向下（insert b[j]）、对角线（match a[i]==b[j]）
 * - 使用 V 数组按对角线 k = x - y 分组，避免显式构建图
 * - 时间复杂度 O(ND)，D 为编辑距离（差异越大越慢，但通常 D 远小于 N+M）
 *
 * 模块导出：
 * - computeMyersDiff：计算两个字符串数组的差异，返回 DiffOp 序列
 * - groupIntoHunks：将 DiffOp 序列按 contextLines 分组为 hunks
 * - computeStats：统计 DiffOp 序列的新增/删除/变更行数
 * - DiffOp / DiffHunk / DiffStats：类型定义
 *
 * 大文件降级保护：
 * - 当 oldLines.length + newLines.length > NAIVE_DIFF_THRESHOLD 时，
 *   降级为朴素 diff（全部 delete + 全部 insert），避免 Myers 算法的 O(ND) 退化为 O(N²)
 * - 朴素 diff 不计算 LCS 匹配，性能 O(N+M)，但 diff 输出冗长
 */

/**
 * diff 操作类型
 * - "equal"：行未变更（a[i] === b[j]）
 * - "delete"：行被删除（仅存在于旧序列）
 * - "insert"：行被插入（仅存在于新序列）
 */
export type DiffOpType = "equal" | "delete" | "insert";

/**
 * 单个 diff 操作
 *
 * @property type 操作类型
 * @property text 行文本内容
 * @property oldLineNo 旧行号（从 1 开始；insert 操作为 undefined）
 * @property newLineNo 新行号（从 1 开始；delete 操作为 undefined）
 */
export interface DiffOp {
  type: DiffOpType;
  text: string;
  /** 旧行号（从 1 开始；insert 操作为 undefined） */
  oldLineNo?: number;
  /** 新行号（从 1 开始；delete 操作为 undefined） */
  newLineNo?: number;
}

/**
 * diff hunk（变更块）
 *
 * 一个 hunk 包含一段连续的变更及其上下文行，对应 unified diff 中的一个 @@ 块。
 *
 * @property oldStart 旧文件起始行号（从 1 开始；纯插入时为 0）
 * @property oldLines 旧文件的行数（纯插入时为 0）
 * @property newStart 新文件起始行号（从 1 开始；纯删除时为 0）
 * @property newLines 新文件的行数（纯删除时为 0）
 * @property ops 该 hunk 包含的 diff 操作列表
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: DiffOp[];
}

/**
 * diff 统计信息
 *
 * @property additions 新增行数（insert 操作数）
 * @property deletions 删除行数（delete 操作数）
 * @property changes 变更总数（additions + deletions）
 */
export interface DiffStats {
  additions: number;
  deletions: number;
  changes: number;
}

/**
 * 大文件降级阈值
 *
 * 当 oldLines.length + newLines.length 超过此值时，降级为朴素 diff。
 * 阈值 20000 在实践中覆盖大部分源代码文件，避免 Myers 算法在大文件上退化。
 */
const NAIVE_DIFF_THRESHOLD = 20000;

/**
 * 计算两个字符串数组的 Myers diff
 *
 * 算法流程：
 * 1. 大文件降级检查：超过阈值时使用朴素 diff
 * 2. 边界情况：空输入直接返回对应的 insert/delete 序列
 * 3. 前向搜索：按 d（编辑距离）递增，使用 V 数组记录每条对角线 k 的最远 x 坐标
 * 4. 回溯：从终点 (n, m) 沿 V 数组回溯到起点 (0, 0)，生成 DiffOp 序列
 *
 * @param oldLines 旧文件行数组（每行不含换行符）
 * @param newLines 新文件行数组（每行不含换行符）
 * @returns DiffOp 序列（按文件顺序排列，从行 1 开始）
 */
export function computeMyersDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  // 边界情况：两个空序列
  if (n === 0 && m === 0) {
    return [];
  }

  // 大文件降级：超过阈值时使用朴素 diff
  // 朴素 diff 全部为 delete + insert，不计算 LCS 匹配，性能 O(N+M)
  if (n + m > NAIVE_DIFF_THRESHOLD) {
    return naiveDiff(oldLines, newLines);
  }

  // 边界情况：旧序列为空，全部为 insert
  if (n === 0) {
    return newLines.map((text, i) => ({
      type: "insert" as const,
      text,
      newLineNo: i + 1,
    }));
  }

  // 边界情况：新序列为空，全部为 delete
  if (m === 0) {
    return oldLines.map((text, i) => ({
      type: "delete" as const,
      text,
      oldLineNo: i + 1,
    }));
  }

  // 执行 Myers 算法
  return myersDiffCore(oldLines, newLines, n, m);
}

/**
 * 朴素 diff：全部 delete + 全部 insert
 *
 * 不计算 LCS 匹配，直接将旧序列全部删除、新序列全部插入。
 * 用于大文件降级场景，避免 Myers 算法的 O(ND) 退化为 O(N²)。
 *
 * @param oldLines 旧文件行数组
 * @param newLines 新文件行数组
 * @returns DiffOp 序列（先全部 delete，后全部 insert）
 */
function naiveDiff(oldLines: string[], newLines: string[]): DiffOp[] {
  const ops: DiffOp[] = [];

  // 旧序列全部删除
  for (let i = 0; i < oldLines.length; i++) {
    ops.push({
      type: "delete",
      text: oldLines[i],
      oldLineNo: i + 1,
    });
  }

  // 新序列全部插入
  for (let j = 0; j < newLines.length; j++) {
    ops.push({
      type: "insert",
      text: newLines[j],
      newLineNo: j + 1,
    });
  }

  return ops;
}

/**
 * Myers 算法核心实现
 *
 * @param a 旧序列
 * @param b 新序列
 * @param n 旧序列长度
 * @param m 新序列长度
 * @returns DiffOp 序列
 */
function myersDiffCore(a: string[], b: string[], n: number, m: number): DiffOp[] {
  const max = n + m;
  // V 数组：按对角线 k = x - y 索引，记录每条对角线的最远 x 坐标
  // 使用偏移 max 避免 k 为负数时的索引问题
  const offset = max;
  const v: number[] = new Array(2 * max + 1).fill(0);

  // trace：记录每一步搜索开始前的 V 数组状态，用于回溯
  const trace: number[][] = [];

  let foundD = -1;

  // 前向搜索：d 从 0 递增到 max
  // d 表示当前允许的编辑操作数（每一步 +1 个 delete 或 insert）
  for (let d = 0; d <= max; d++) {
    // 保存当前 V 数组状态（第 d 步开始前）
    trace.push([...v]);

    // 遍历对角线 k = -d, -d+2, ..., d-2, d
    // k 的奇偶性与 d 相同（因为每步 d 增加 1，k 步长 2）
    for (let k = -d; k <= d; k += 2) {
      let x: number;

      // 确定从哪条对角线扩展：
      // - k === -d：只能从 k+1 向下扩展（insert）
      // - k === d：只能从 k-1 向右扩展（delete）
      // - 其他情况：选择 x 较大的方向（优先匹配）
      if (k === -d) {
        x = v[k + 1 + offset];
      } else if (k === d) {
        x = v[k - 1 + offset] + 1;
      } else if (v[k - 1 + offset] < v[k + 1 + offset]) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }

      let y = x - k;

      // 沿对角线移动：尽可能多地匹配 a[x] === b[y]
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }

      v[k + offset] = x;

      // 到达终点 (n, m)：找到最短编辑距离
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }

    if (foundD >= 0) {
      break;
    }
  }

  // 如果未找到路径（不应发生，因为 max = n + m 是上界），降级为朴素 diff
  if (foundD < 0) {
    return naiveDiff(a, b);
  }

  // 回溯生成 DiffOp 序列
  return backtrack(a, b, trace, n, m, offset, foundD);
}

/**
 * 回溯生成 DiffOp 序列
 *
 * 从终点 (n, m) 沿 trace 回溯到起点 (0, 0)：
 * - 在第 d 步，根据 V 数组确定前一步的位置
 * - 处理对角线移动（equal）：从 回到
 * - 处理编辑操作：delete（向右移动）或 insert（向下移动）
 *
 * @param a 旧序列
 * @param b 新序列
 * @param trace 每一步的 V 数组状态
 * @param n 旧序列长度
 * @param m 新序列长度
 * @param offset V 数组的偏移量
 * @param foundD 最短编辑距离
 * @returns DiffOp 序列（按文件顺序排列）
 */
function backtrack(
  a: string[],
  b: string[],
  trace: number[][],
  n: number,
  m: number,
  offset: number,
  foundD: number
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;

  // 从第 foundD 步回溯到第 1 步
  for (let d = foundD; d > 0; d--) {
    const v = trace[d];
    const k = x - y;

    // 确定前一步的 k 值
    let prevK: number;
    if (k === -d) {
      prevK = k + 1;
    } else if (k === d) {
      prevK = k - 1;
    } else if (v[k - 1 + offset] < v[k + 1 + offset]) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    // 处理对角线移动（equal）：从 回到
    // 这些是编辑操作之后的匹配行
    while (x > prevX && y > prevY) {
      ops.push({
        type: "equal",
        text: a[x - 1],
        oldLineNo: x,
        newLineNo: y,
      });
      x--;
      y--;
    }

    // 处理编辑操作
    if (x > prevX) {
      // delete：a[x-1] 被删除（向右移动）
      ops.push({
        type: "delete",
        text: a[x - 1],
        oldLineNo: x,
      });
      x--;
    } else if (y > prevY) {
      // insert：b[y-1] 被插入（向下移动）
      ops.push({
        type: "insert",
        text: b[y - 1],
        newLineNo: y,
      });
      y--;
    }
  }

  // 处理 d=0 时的对角线移动（从起点 (0,0) 到第一个编辑操作前的匹配）
  while (x > 0 && y > 0) {
    ops.push({
      type: "equal",
      text: a[x - 1],
      oldLineNo: x,
      newLineNo: y,
    });
    x--;
    y--;
  }

  // 回溯是从终点到起点，需要反转得到从起点到终点的顺序
  ops.reverse();
  return ops;
}

/**
 * 将 DiffOp 序列按 contextLines 分组为 hunks
 *
 * 分组规则：
 * 1. 找到所有变更操作（delete + insert）的位置
 * 2. 相邻变更（中间 equal 行数 <= 2 * contextLines）合并为一个 hunk
 * 3. 远距离变更（中间 equal 行数 > 2 * contextLines）拆分为独立 hunk
 * 4. 每个 hunk 包含变更行及其前后各 contextLines 行上下文
 *
 * @param ops DiffOp 序列（来自 computeMyersDiff）
 * @param contextLines 上下文行数（变更行前后保留的 equal 行数）
 * @returns DiffHunk 列表（按文件顺序排列）
 */
export function groupIntoHunks(ops: DiffOp[], contextLines: number): DiffHunk[] {
  if (ops.length === 0) {
    return [];
  }

  // 找到所有变更操作的位置（索引）
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "equal") {
      changeIndices.push(i);
    }
  }

  // 无变更操作时返回空数组
  if (changeIndices.length === 0) {
    return [];
  }

  // 分组变更：相邻变更合并为一个组
  // 判据：两个变更之间的 equal 数 <= 2 * contextLines 时合并
  const groups: number[][] = [];
  let currentGroup: number[] = [changeIndices[0]];

  for (let i = 1; i < changeIndices.length; i++) {
    const prevChange = changeIndices[i - 1];
    const currChange = changeIndices[i];
    // 两个变更之间的 equal 操作数
    const equalCountBetween = currChange - prevChange - 1;

    if (equalCountBetween <= 2 * contextLines) {
      // 相邻：合并到当前组
      currentGroup.push(currChange);
    } else {
      // 远距离：关闭当前组，开新组
      groups.push(currentGroup);
      currentGroup = [currChange];
    }
  }
  groups.push(currentGroup);

  // 为每个分组生成 hunk
  const hunks: DiffHunk[] = [];
  for (const group of groups) {
    const firstChange = group[0];
    const lastChange = group[group.length - 1];

    // hunk 范围：[firstChange - contextLines, lastChange + contextLines]
    const startIdx = Math.max(0, firstChange - contextLines);
    const endIdx = Math.min(ops.length - 1, lastChange + contextLines);

    const hunkOps = ops.slice(startIdx, endIdx + 1);
    hunks.push(buildHunk(hunkOps));
  }

  return hunks;
}

/**
 * 从 DiffOp 列表构建单个 hunk
 *
 * 计算 hunk 的起始行号和行数：
 * - oldStart：第一个有 oldLineNo 的操作的旧行号；纯插入时为 0
 * - newStart：第一个有 newLineNo 的操作的新行号；纯删除时为 0
 * - oldLines：equal + delete 操作数
 * - newLines：equal + insert 操作数
 *
 * @param hunkOps hunk 包含的 diff 操作列表
 * @returns DiffHunk 对象
 */
function buildHunk(hunkOps: DiffOp[]): DiffHunk {
  // 找到第一个有 oldLineNo 的操作（equal 或 delete）
  const firstWithOld = hunkOps.find((op) => op.oldLineNo !== undefined);
  // 找到第一个有 newLineNo 的操作（equal 或 insert）
  const firstWithNew = hunkOps.find((op) => op.newLineNo !== undefined);

  // 纯插入时 oldStart = 0（git 约定：/dev/null 表示无旧文件）
  // 纯删除时 newStart = 0（git 约定：删除后无新文件）
  const oldStart = firstWithOld?.oldLineNo ?? 0;
  const newStart = firstWithNew?.newLineNo ?? 0;

  // 统计行数
  let oldLines = 0;
  let newLines = 0;
  for (const op of hunkOps) {
    if (op.type === "equal" || op.type === "delete") {
      oldLines++;
    }
    if (op.type === "equal" || op.type === "insert") {
      newLines++;
    }
  }

  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    ops: hunkOps,
  };
}

/**
 * 计算 DiffOp 序列的统计信息
 *
 * @param ops DiffOp 序列
 * @returns DiffStats：additions（insert 数）、deletions（delete 数）、changes（两者之和）
 */
export function computeStats(ops: DiffOp[]): DiffStats {
  let additions = 0;
  let deletions = 0;

  for (const op of ops) {
    if (op.type === "insert") {
      additions++;
    } else if (op.type === "delete") {
      deletions++;
    }
  }

  return {
    additions,
    deletions,
    changes: additions + deletions,
  };
}
