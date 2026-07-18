/**
 * EDM 红线判定器实现
 *
 * 本模块实现 EAG 方案 §5.7.2 定义的 3 条 EDM 专属红线判定器（表驱动设计），
 * 提供静态可判的确定性判定逻辑（禁止 mock/simulated/placeholder）。
 *
 * 红线清单：
 * | ID     | 名称                       | 级别    | 判定方式                                  |
 * |--------|----------------------------|---------|------------------------------------------|
 * | EDM-01 | 权限判定不得仅在前端        | BLOCKER | 扫描架构文档分层与代码片段，识别前端-only 校验 |
 * | EDM-02 | 数据权限查询改写覆盖完整性   | MAJOR   | 对比列表查询接口清单与改写覆盖清单           |
 * | EDM-03 | 角色互斥约束授权时校验       | MAJOR   | 扫描授权流程步骤与 SoD 校验标志             |
 *
 * 设计依据：
 * - EAG 方案 §5.7.2 EDM 评估器专项红线
 * - §5.7.1 各域设计决策（功能权限域双层校验、数据权限域查询改写、角色域 SoD 互斥）
 *
 * 判定原则：
 * - 表驱动设计：每条红线对应一个独立的判定函数，易于扩展与测试
 * - 静态可判：基于架构文档与代码片段的确定性判定，不依赖 LLM 推理
 * - 误报优先于漏报：宁可误报打回人工审查，不可漏报放过安全漏洞
 *
 * @module eag/edm/edm-redlines
 */

import type { EdmRedlineViolation, EdmRedlineId, EdmRedlineSeverity } from "./types";
import { EDM_REDLINE_SEVERITY_MAP } from "./types";

// ============================================================================
// 辅助：构造红线违反记录
// ============================================================================

/**
 * 构造红线违反记录
 *
 * 从 EDM_REDLINE_SEVERITY_MAP 查询严重级别，避免硬编码。
 *
 * @param id 红线 ID
 * @param message 违反详情
 * @param location 违反位置
 * @returns 红线违反记录
 */
function buildViolation(id: EdmRedlineId, message: string, location: string): EdmRedlineViolation {
  const severity: EdmRedlineSeverity = EDM_REDLINE_SEVERITY_MAP[id];
  return { id, severity, message, location };
}

// ============================================================================
// EDM-01: 权限判定不得仅在前端（BLOCKER）
// ============================================================================

/**
 * EDM-01 判定输入：架构文档与代码片段
 *
 * - architectureDocument.layering：架构分层清单（每层含 name 与 responsibility）
 *   用于检查是否存在独立的"服务层"承载权限校验职责
 * - codeSnippets：可选的代码片段列表（每段含 file 与 content）
 *   用于扫描代码中是否存在权限校验调用（如 permissionService.check()）
 */
export interface Edm01Artifacts {
  readonly architectureDocument: {
    readonly layering: ReadonlyArray<{
      readonly name: string;
      readonly responsibility: string;
    }>;
  };
  readonly codeSnippets?: ReadonlyArray<{
    readonly file: string;
    readonly content: string;
  }>;
}

/**
 * EDM-01 判定：权限判定不得仅在前端（BLOCKER）
 *
 * 判定规则（满足任一即视为违反）：
 * 1. 架构分层中无"服务层"（service layer）承载权限校验职责
 *    - 检查 layering 列表中是否存在 name 包含 "service" 或 "application" 的层
 *    - 检查该层的 responsibility 是否提及"权限校验"/"权限判定"/"authorization"
 *    - 若无服务层，或服务层职责未提及权限校验 → 违反
 * 2. 代码片段中权限校验仅出现在前端文件（如 .vue/.jsx/.tsx）而后端无校验
 *    - 扫描 codeSnippets，识别权限校验调用（permission/check/authorize 关键词）
 *    - 若仅前端文件含权限校验调用，后端文件无 → 违反
 *
 * 严重级别：BLOCKER（不可豁免，必须修复）
 *
 * @param artifacts 架构文档与代码片段
 * @returns 违反记录列表（空列表表示通过）
 */
export function checkEdm01FrontendOnlyPermission(artifacts: Edm01Artifacts): EdmRedlineViolation[] {
  const violations: EdmRedlineViolation[] = [];
  const { architectureDocument, codeSnippets } = artifacts;

  // 判定规则 1：检查架构分层是否存在承载权限校验的服务层
  // 服务层关键词：service / application（DDD 应用层）/ usecase（Clean Architecture 用例层）
  const serviceLayerKeywords = ["service", "application", "usecase", "use-case"];
  // 权限校验关键词：authorization / permission / check
  const permissionKeywords = ["权限校验", "权限判定", "authorization", "permission check", "权限检查"];

  // 查找承载权限校验职责的服务层
  let hasServiceLayerWithPermission = false;
  for (const layer of architectureDocument.layering) {
    const layerNameLower = layer.name.toLowerCase();
    const isServiceLayer = serviceLayerKeywords.some((kw) => layerNameLower.includes(kw));
    if (!isServiceLayer) continue;

    // 检查该服务层的职责描述是否提及权限校验
    const responsibilityLower = layer.responsibility.toLowerCase();
    const mentionsPermission = permissionKeywords.some((kw) => responsibilityLower.includes(kw.toLowerCase()));
    if (mentionsPermission) {
      hasServiceLayerWithPermission = true;
      break;
    }
  }

  // 若架构分层中无承载权限校验的服务层 → 违反规则 1
  if (!hasServiceLayerWithPermission) {
    violations.push(
      buildViolation(
        "EDM-01",
        "架构分层中未发现承载权限校验职责的服务层（service/application/usecase 层的" +
          "responsibility 未提及'权限校验'/'权限判定'/'authorization'）。" +
          "权限判定仅在前端将导致用户可篡改 SPA 代码或直接调 API 绕过权限，" +
          "必须在后端服务层强制校验。",
        "architectureDocument.layering"
      )
    );
  }

  // 判定规则 2：若提供了代码片段，检查权限校验是否仅在前端
  if (codeSnippets && codeSnippets.length > 0) {
    // 前端文件扩展名：.vue/.jsx/.tsx/.html/.svelte
    const frontendFileExtensions = [".vue", ".jsx", ".tsx", ".html", ".svelte"];
    // 后端文件扩展名：.ts/.js/.java/.go/.py（排除前端扩展名）
    const backendFileExtensions = [".ts", ".js", ".java", ".go", ".py"];

    // 代码层权限校验调用关键词（覆盖主流框架）
    const permissionCheckPatterns = [
      "permissionService",
      "permissionCheck",
      "hasPermission",
      "checkPermission",
      "@RequirePermission",
      "@PreAuthorize",
      "authorize(",
      "can(",
    ];

    // 收集含权限校验调用的文件
    const frontendFilesWithPermission: string[] = [];
    const backendFilesWithPermission: string[] = [];

    for (const snippet of codeSnippets) {
      const fileLower = snippet.file.toLowerCase();
      const contentLower = snippet.content.toLowerCase();
      const hasPermissionCall = permissionCheckPatterns.some((p) => contentLower.includes(p.toLowerCase()));
      if (!hasPermissionCall) continue;

      // 判断文件类型（前端 / 后端）
      const isFrontend = frontendFileExtensions.some((ext) => fileLower.endsWith(ext));
      // 后端判定：扩展名匹配且不是前端扩展名
      const isBackend =
        backendFileExtensions.some((ext) => fileLower.endsWith(ext)) &&
        !frontendFileExtensions.some((ext) => fileLower.endsWith(ext));

      if (isFrontend) {
        frontendFilesWithPermission.push(snippet.file);
      } else if (isBackend) {
        backendFilesWithPermission.push(snippet.file);
      }
    }

    // 若前端含权限校验但后端无 → 违反规则 2
    if (frontendFilesWithPermission.length > 0 && backendFilesWithPermission.length === 0) {
      violations.push(
        buildViolation(
          "EDM-01",
          `代码片段中权限校验仅出现在前端文件（${frontendFilesWithPermission.join(", ")}），` +
            "后端服务层未发现权限校验调用（permissionService/hasPermission/@PreAuthorize 等）。" +
            "前端权限判定可被用户篡改 SPA 代码或直接调 API 绕过，必须在后端服务层强制校验。",
          frontendFilesWithPermission.join(", ")
        )
      );
    }
  }

  return violations;
}

// ============================================================================
// EDM-02: 数据权限查询改写必须覆盖全部列表查询接口（MAJOR）
// ============================================================================

/**
 * EDM-02 判定输入：列表查询接口清单与改写覆盖清单
 *
 * - listApis：全部列表查询接口清单（含 path 与 method）
 * - rewrittenApis：已经过数据权限查询改写的接口清单（listApis 的子集）
 *
 * 判定逻辑：listApis 中存在但 rewrittenApis 中不存在的接口 → 违反
 */
export interface Edm02Artifacts {
  readonly listApis: ReadonlyArray<{ readonly path: string; readonly method: string }>;
  readonly rewrittenApis: ReadonlyArray<{ readonly path: string; readonly method: string }>;
}

/**
 * 接口标识符（method + path，用于去重与比对）
 *
 * 将 method 大写化，path 去除尾部斜杠，确保比对一致。
 */
interface ApiIdentifier {
  readonly method: string;
  readonly path: string;
}

/**
 * 规范化接口标识符
 *
 * @param api 接口对象
 * @returns 规范化后的标识符（method 大写，path 去除尾部斜杠）
 */
function normalizeApi(api: { path: string; method: string }): ApiIdentifier {
  return {
    method: api.method.toUpperCase(),
    // 去除尾部斜杠（如 /api/orders/ → /api/orders），保留根路径 "/"
    path: api.path.endsWith("/") && api.path.length > 1 ? api.path.slice(0, -1) : api.path,
  };
}

/**
 * 接口标识符字符串化（用于 Set 去重与 Map key）
 *
 * @param api 接口标识符
 * @returns "${METHOD} ${PATH}" 格式的字符串
 */
function apiKey(api: ApiIdentifier): string {
  return `${api.method} ${api.path}`;
}

/**
 * EDM-02 判定：数据权限查询改写必须覆盖全部列表查询接口（MAJOR）
 *
 * 判定规则：
 * - 对比 listApis 与 rewrittenApis，找出未覆盖的接口
 * - 未覆盖的接口（在 listApis 中但不在 rewrittenApis 中）每条产生一条违反记录
 * - 接口比对基于 method + path（method 大写化，path 去除尾部斜杠规范化）
 *
 * 业务理由：
 * 未覆盖的接口将成为数据越权漏洞，攻击者可通过未改写的接口访问无权数据。
 * 例如：列表查询接口 GET /api/orders 已被改写（仅返回本人订单），
 * 但导出接口 GET /api/orders/export 未被改写（返回全部订单），
 * 攻击者可通过导出接口绕过数据权限。
 *
 * 严重级别：MAJOR（可人工豁免，但默认打回——某些接口可能确实不需要数据权限，但需人工确认）
 *
 * @param artifacts 接口清单与改写覆盖清单
 * @returns 违反记录列表（空列表表示全部覆盖，通过）
 */
export function checkEdm02DataScopeQueryRewriteCoverage(artifacts: Edm02Artifacts): EdmRedlineViolation[] {
  const violations: EdmRedlineViolation[] = [];
  const { listApis, rewrittenApis } = artifacts;

  // 构建 rewrittenApis 的标识符集合（method + path，规范化后去重）
  const rewrittenSet = new Set<string>();
  for (const api of rewrittenApis) {
    rewrittenSet.add(apiKey(normalizeApi(api)));
  }

  // 遍历 listApis，找出未覆盖的接口
  // 使用 Set 去重，避免同一接口被多次列出导致重复违反记录
  const uncoveredSet = new Set<string>();
  const uncoveredApis: { method: string; path: string }[] = [];
  for (const api of listApis) {
    const normalized = normalizeApi(api);
    const key = apiKey(normalized);
    if (!rewrittenSet.has(key) && !uncoveredSet.has(key)) {
      uncoveredSet.add(key);
      uncoveredApis.push(normalized);
    }
  }

  // 每条未覆盖的接口产生一条违反记录
  for (const api of uncoveredApis) {
    violations.push(
      buildViolation(
        "EDM-02",
        `列表查询接口 ${api.method} ${api.path} 未经过数据权限查询改写。` +
          "未覆盖的接口将成为数据越权漏洞，攻击者可通过未改写的接口访问无权数据。" +
          "必须在查询改写器（query rewriter）中为该接口注入行级 WHERE 条件与列级 SELECT 改写。",
        `${api.method} ${api.path}`
      )
    );
  }

  return violations;
}

// ============================================================================
// EDM-03: 角色互斥约束必须在授权时校验（MAJOR）
// ============================================================================

/**
 * EDM-03 判定输入：授权流程与 SoD 校验标志
 *
 * - assignRoleFlow：授权流程定义（含步骤列表，如 ["校验角色存在", "校验 SoD 互斥", "保存分配记录"]）
 * - hasSoDCheck：是否在授权流程中包含 SoD 校验步骤（布尔标志）
 *
 * 判定逻辑：
 * - 若 hasSoDCheck=false → 违反（明确未校验）
 * - 若 hasSoDCheck=true 但 assignRoleFlow.steps 中无"SoD"/"互斥"关键词 → 违反（标志与流程不一致）
 */
export interface Edm03Artifacts {
  readonly assignRoleFlow?: {
    readonly steps: ReadonlyArray<string>;
  };
  readonly hasSoDCheck: boolean;
}

/**
 * EDM-03 判定：角色互斥约束必须在授权时校验（MAJOR）
 *
 * 判定规则（满足任一即视为违反）：
 * 1. hasSoDCheck=false → 明确未校验 SoD 互斥
 * 2. hasSoDCheck=true 但 assignRoleFlow.steps 中无"SoD"/"互斥"/"职责分离"关键词
 *    → 标志与流程不一致，疑似标志位被错误设置
 *
 * 业务理由：
 * SoD（职责分离）是企业内控（SOX 法案合规）的核心约束。
 * 典型场景："制单"与"审批"互斥——同一用户不得同时持有这两个角色，
 * 否则可自己审批自己创建的单据，导致舞弊风险。
 * 授权时未校验将导致一人多权，违反内控合规要求。
 *
 * 严重级别：MAJOR（可人工豁免——某些场景可能确实不需要 SoD，但需人工确认）
 *
 * @param artifacts 授权流程与 SoD 校验标志
 * @returns 违反记录列表（空列表表示通过）
 */
export function checkEdm03RoleMutualExclusionCheck(artifacts: Edm03Artifacts): EdmRedlineViolation[] {
  const violations: EdmRedlineViolation[] = [];
  const { assignRoleFlow, hasSoDCheck } = artifacts;

  // 判定规则 1：hasSoDCheck=false → 明确未校验
  if (!hasSoDCheck) {
    violations.push(
      buildViolation(
        "EDM-03",
        "授权流程未启用 SoD（职责分离）互斥校验（hasSoDCheck=false）。" +
          "SoD 是企业内控（SOX 合规）的核心约束，如'制单'与'审批'互斥，" +
          "未校验将导致一人多权舞弊风险。必须在授权流程中强制校验互斥角色对。",
        "assignRoleFlow.hasSoDCheck"
      )
    );
    // 已明确未启用，无需再检查步骤一致性
    return violations;
  }

  // 判定规则 2：hasSoDCheck=true 但授权流程步骤中无 SoD 关键词
  // 防止标志位被错误设置为 true 而流程实际未实现
  if (assignRoleFlow) {
    const sodKeywords = ["sod", "互斥", "职责分离"];
    const stepsText = assignRoleFlow.steps.join(" ").toLowerCase();
    const hasSodStep = sodKeywords.some((kw) => stepsText.includes(kw.toLowerCase()));

    if (!hasSodStep) {
      violations.push(
        buildViolation(
          "EDM-03",
          "授权流程声明启用 SoD 互斥校验（hasSoDCheck=true），但流程步骤中未发现 SoD / 互斥 / 职责分离 关键词。" +
            "标志位与流程实现不一致，疑似标志位被错误设置或 SoD 校验逻辑未实际接入流程。" +
            "请在授权流程中显式添加'校验 SoD 互斥约束'步骤，调用 SoDConstraintVO 校验互斥角色对。",
          "assignRoleFlow.steps"
        )
      );
    }
  } else {
    // hasSoDCheck=true 但未提供 assignRoleFlow → 无法验证流程实现
    violations.push(
      buildViolation(
        "EDM-03",
        "授权流程声明启用 SoD 互斥校验（hasSoDCheck=true），但未提供 assignRoleFlow 流程定义。" +
          "无法验证 SoD 校验是否实际接入授权流程，需补充流程步骤说明以便审计。",
        "assignRoleFlow (missing)"
      )
    );
  }

  return violations;
}

// ============================================================================
// 红线判定器注册表（表驱动设计）
// ============================================================================

/**
 * 红线判定器函数类型
 *
 * 每条红线对应一个判定函数，接收特定类型的 artifacts 输入，返回违反记录列表。
 * 使用泛型参数 TArtifacts 支持不同红线的不同输入类型。
 */
export type EdmRedlineChecker<TArtifacts> = (artifacts: TArtifacts) => EdmRedlineViolation[];

/**
 * EDM 红线判定器注册表
 *
 * 表驱动设计：将所有红线判定函数注册在表中，便于：
 * - 评估器统一调度：遍历注册表逐条调用
 * - 测试时按 ID 查找判定函数单独测试
 * - 未来扩展新红线时仅需在表中新增条目
 *
 * 注意：由于不同红线的 artifacts 类型不同，注册表使用 any 作为参数类型，
 * 调用方需按红线 ID 选择对应的判定函数并传入正确类型的 artifacts。
 * 类型安全由各判定函数自身的参数类型保证。
 */
export const EDM_REDLINE_CHECKERS: Readonly<Record<EdmRedlineId, EdmRedlineChecker<unknown>>> = Object.freeze({
  "EDM-01": checkEdm01FrontendOnlyPermission as EdmRedlineChecker<unknown>,
  "EDM-02": checkEdm02DataScopeQueryRewriteCoverage as EdmRedlineChecker<unknown>,
  "EDM-03": checkEdm03RoleMutualExclusionCheck as EdmRedlineChecker<unknown>,
});
