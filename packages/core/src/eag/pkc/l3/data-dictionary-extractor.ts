/**
 * K4 业务数据理解器实现（EAG-P2 批次 8）
 *
 * 本模块实现 `DataDictionaryExtractor` 类，提供 EAG 方案 §5.11.2 K4 业务数据理解的真实逻辑。
 *
 * 核心职责：
 * - extract(projectRoot)：扫描项目代码与 schema，产出 DataDictionary
 * - 字典表/枚举/常量类识别（如 order_status: 1=待支付 2=已支付）
 * - 字段业务语义推断（comment + 命名 + 使用上下文）
 * - 敏感字段标注（与 EDM 数据权限列级脱敏联动）
 *
 * §5.11.2 K4 业务数据理解设计要求：
 * - 字典表/枚举/常量类识别
 * - 字段业务语义推断（comment + 命名 + 使用上下文）
 * - 敏感字段标注（与 EDM 数据权限列级脱敏联动）
 *
 * 设计依据：
 * - EAG 方案 §5.11.2 K4 业务数据理解
 * - EDM 数据权限列级脱敏（识别敏感字段以联动脱敏规则）
 *
 * 实现说明：
 * - 多语言枚举/常量类识别（TypeScript/JavaScript/Java/Python/Go）
 *   * TypeScript/JavaScript：enum X { A = 1, B = 2 } / const X = { A: 1, B: 2 } as const
 *   * Java：enum X { A, B }
 *   * Python：class X(Enum): A = 1
 *   * Go：const ( A X = iota )
 * - 字典表识别：表名含 dict/dictionary/type/config 且含 key/value/code/name 列
 * - 字段语义推断：综合 SQL COMMENT / 字段命名 / ORM @Comment / 使用上下文
 * - 敏感字段识别：基于字段名/类型/注释匹配 PII/支付/认证模式
 *   * 高敏感：password/secret/token/credential/private_key/api_key
 *   * 中敏感：email/phone/mobile/id_card/passport/bank_card/salary/balance
 *   * 低敏感：name/address/birthday/avatar
 *
 * 不可变优先：
 * - 公开方法返回冻结对象
 *
 * @module eag/pkc/l3/data-dictionary-extractor
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BusinessEnum,
  BusinessEnumValue,
  DataDictionary,
  DictionaryTable,
  FieldSemantics,
  SensitiveField,
} from "./l3-types";
import type { DatabaseTable } from "./l3-types";

// ============================================================================
// 枚举/常量类识别规则
// ============================================================================

/**
 * 枚举/常量类提取规则
 *
 * 用于多语言枚举/常量类的正则识别。
 */
interface EnumExtractionRule {
  /** 规则名（用于日志与测试断言） */
  readonly name: string;
  /** 正则表达式 */
  readonly pattern: RegExp;
  /** 适用文件扩展名 */
  readonly extensions: ReadonlyArray<string>;
}

/**
 * 多语言枚举/常量类识别规则表
 *
 * 覆盖：
 * - TypeScript/JavaScript enum X { A, B = 1 }
 * - TypeScript/JavaScript const X = { A: 1, B: 2 } as const
 * - Java enum X { A, B }
 * - Python class X(Enum): A = 1
 * - Go const ( A X = iota )
 */
const ENUM_EXTRACTION_RULES: ReadonlyArray<EnumExtractionRule> = Object.freeze([
  // TypeScript/JavaScript：enum X { A = 1, B = 2 }
  {
    name: "ts-enum",
    pattern: /\benum\s+([A-Z][a-zA-Z0-9_]*)\s*\{([\s\S]*?)\}/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // TypeScript/JavaScript：const X = { A: 1, B: 2 } as const
  {
    name: "ts-const-dict",
    pattern: /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([\s\S]*?)\}\s*as\s+const/g,
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  // Java：enum X { A, B }（带可选构造参数）
  {
    name: "java-enum",
    pattern: /\benum\s+([A-Z][a-zA-Z0-9_]*)\s*(?:implements\s+[A-Z][a-zA-Z0-9_]*\s*)?\{([\s\S]*?)\}/g,
    extensions: [".java"],
  },
  // Python：class X(Enum): A = 1
  // lookahead 边界说明：
  // - \n\nclass\s：空行 + 顶层 class 定义（Python 缩进规范，顶层类前必空行）
  // - \n\ndef\s：空行 + 顶层函数定义
  // - \nclass\s：行首 + 顶层 class 定义（无空行情况）
  // - \ndef\s：行首 + 顶层函数定义（无空行情况）
  // - $：文件结尾（JavaScript 不支持 \Z，必须用 $）
  // 注：早期版本使用 \n[A-Z] 与 \Z 是错误的：
  //   * \n[A-Z] 会在枚举值 PENDING 等大写字母行首立即触发，导致 body 为空
  //   * \Z 在 JavaScript 中非元字符，被当作字面量 Z，永不匹配
  {
    name: "python-enum",
    pattern:
      /\bclass\s+([A-Z][a-zA-Z0-9_]*)\s*\(\s*(?:Enum|IntEnum|StrEnum)\s*\)\s*:([\s\S]*?)(?=\n\nclass\s|\n\ndef\s|\nclass\s|\ndef\s|$)/g,
    extensions: [".py"],
  },
  // Go：const ( A X = iota )
  {
    name: "go-const-enum",
    pattern: /\bconst\s*\(\s*([A-Z][a-zA-Z0-9_]*)\s+([A-Z][a-zA-Z0-9_]*)\s*=\s*iota([\s\S]*?)\)/g,
    extensions: [".go"],
  },
]);

/**
 * Java 枚举带构造参数模式（如 ORDER_PENDING(1, "待支付")）
 *
 * 捕获组：1=枚举名，2=构造参数列表
 */
const JAVA_ENUM_WITH_ARGS_PATTERN: RegExp = /^\s*([A-Z_][A-Z0-9_]*)\s*\(([^)]*)\)\s*(?:[,;]|\n|$)/gm;

// ============================================================================
// 字典表识别规则
// ============================================================================

/**
 * 字典表名识别模式
 *
 * 字典表名通常包含 dict/dictionary/type/config 等关键词：
 * - sys_dict / dict_order_status
 * - order_type_dict / payment_method_dict
 */
const DICTIONARY_TABLE_NAME_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bdict_([a-z_]+)/i,
  /\b([a-z_]+)_dict\b/i,
  /\b([a-z_]+)_dictionary\b/i,
  /\b([a-z_]+)_type\b/i,
  /\bsys_([a-z_]+)_config\b/i,
  /\b([a-z_]+)_config_dict\b/i,
  /\bdictionary_([a-z_]+)/i,
]);

/**
 * 字典表 key/value 列识别模式
 *
 * 字典表通常含 key/value/code/name 类型的字段：
 * - code/value/id + name/label/desc
 * - key/value 对
 */
const DICTIONARY_KEY_COLUMN_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^(code|key|value_code|enum_value|item_code|dict_key|id)$/i,
]);

const DICTIONARY_VALUE_COLUMN_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^(name|label|value_name|desc|description|item_name|dict_value|display_name|display_value|title|text)$/i,
]);

// ============================================================================
// 敏感字段识别规则
// ============================================================================

/**
 * 敏感字段识别规则
 *
 * 用于识别需联动 EDM 列级脱敏的字段。
 * 字段名匹配（忽略大小写、snake_case 与 camelCase 等价）。
 */
interface SensitiveFieldPattern {
  /** 敏感性级别 */
  readonly sensitivity: "high" | "medium" | "low";
  /** 字段名模式（正则） */
  readonly namePattern: RegExp;
  /** 判定原因 */
  readonly reason: string;
  /** 默认脱敏规则（前 3 后 4 保留等） */
  readonly defaultRule: string;
}

/**
 * 敏感字段模式表（按敏感性从高到低排序，先匹配先返回）
 *
 * 高敏感：
 * - password / passwd / pwd / pass：密码（脱敏：全 *）
 * - secret / api_key / access_key / secret_key / private_key：密钥（脱敏：前 4 后 4 保留）
 * - token / access_token / refresh_token：令牌（脱敏：前 4 后 4 保留）
 * - credential / credentials：凭据（脱敏：全 *）
 *
 * 中敏感：
 * - id_card / idcard / id_number / identity_number / citizen_id：身份证号（脱敏：前 6 后 4 保留）
 * - bank_card / bankcard / card_number / card_no / credit_card：银行卡号（脱敏：前 4 后 4 保留）
 * - phone / mobile / telephone / phone_number / mobile_number：手机号（脱敏：前 3 后 4 保留）
 * - email / email_address / mail：邮箱（脱敏：首字母 + *** + @域名）
 * - salary / wage / income / monthly_salary：薪资（脱敏：全部 *）
 * - balance / account_balance / deposit：账户余额（脱敏：全部 *）
 *
 * 低敏感：
 * - name / username / full_name / real_name / display_name：姓名（脱敏：首字 + *）
 * - address / home_address / street_address：地址（脱敏：前 6 后 2 保留）
 * - birthday / birth_date / date_of_birth：生日（脱敏：年份 + ***）
 * - avatar / avatar_url：头像（脱敏：不脱敏，仅标记）
 */
const SENSITIVE_FIELD_PATTERNS: ReadonlyArray<SensitiveFieldPattern> = Object.freeze([
  // 高敏感：密码/密钥/令牌/凭据
  {
    sensitivity: "high",
    namePattern: /^(password|passwd|pwd|pass|user_password|admin_password)$/i,
    reason: "密码字段（含认证信息）",
    defaultRule: "全字段脱敏为 ********",
  },
  {
    sensitivity: "high",
    namePattern: /^(secret|api_key|access_key|secret_key|private_key|public_key|signing_key|encryption_key)$/i,
    reason: "密钥字段（含加密/签名凭据）",
    defaultRule: "前 4 后 4 字符保留，中间替换为 *",
  },
  {
    sensitivity: "high",
    namePattern: /^(token|access_token|refresh_token|auth_token|bearer_token|jwt_token|session_token)$/i,
    reason: "令牌字段（含会话/认证令牌）",
    defaultRule: "前 4 后 4 字符保留，中间替换为 *",
  },
  {
    sensitivity: "high",
    namePattern: /^(credential|credentials|client_secret|oauth_secret)$/i,
    reason: "凭据字段（含 OAuth/客户端密钥）",
    defaultRule: "全字段脱敏为 ********",
  },
  // 中敏感：身份证/银行卡/手机号/邮箱/薪资/余额
  {
    sensitivity: "medium",
    namePattern: /^(id_card|idcard|id_number|identity_number|citizen_id|national_id|resident_id)$/i,
    reason: "身份证号字段（含 PII 信息）",
    defaultRule: "前 6 后 4 字符保留，中间替换为 *",
  },
  {
    sensitivity: "medium",
    namePattern: /^(bank_card|bankcard|card_number|card_no|credit_card|debit_card|card_pan)$/i,
    reason: "银行卡号字段（含支付信息）",
    defaultRule: "前 4 后 4 字符保留，中间替换为 *",
  },
  {
    sensitivity: "medium",
    namePattern: /^(phone|mobile|telephone|phone_number|mobile_number|tel|tel_number|contact_phone)$/i,
    reason: "手机号字段（含 PII 信息）",
    defaultRule: "前 3 后 4 字符保留，中间替换为 *",
  },
  {
    sensitivity: "medium",
    namePattern: /^(email|email_address|mail|user_email|contact_email)$/i,
    reason: "邮箱字段（含 PII 信息）",
    defaultRule: "首字母 + *** + @域名",
  },
  {
    sensitivity: "medium",
    namePattern: /^(salary|wage|income|monthly_salary|annual_salary|base_salary|gross_salary|net_salary)$/i,
    reason: "薪资字段（含敏感财务信息）",
    defaultRule: "全字段脱敏为 ********",
  },
  {
    sensitivity: "medium",
    namePattern: /^(balance|account_balance|deposit|account_amount|wallet_balance|available_balance)$/i,
    reason: "余额字段（含敏感财务信息）",
    defaultRule: "全字段脱敏为 ********",
  },
  // 低敏感：姓名/地址/生日/头像
  {
    sensitivity: "low",
    namePattern: /^(name|username|full_name|real_name|display_name|nick_name|first_name|last_name|user_name)$/i,
    reason: "姓名字段（含 PII 信息）",
    defaultRule: "首字符 + **（保留姓）",
  },
  {
    sensitivity: "low",
    namePattern: /^(address|home_address|street_address|mailing_address|resident_address|detail_address)$/i,
    reason: "地址字段（含 PII 信息）",
    defaultRule: "前 6 后 2 字符保留，中间替换为 *",
  },
  {
    sensitivity: "low",
    namePattern: /^(birthday|birth_date|date_of_birth|dob|birthday_date)$/i,
    reason: "生日字段（含 PII 信息）",
    defaultRule: "年份保留 + 月日替换为 **",
  },
  {
    sensitivity: "low",
    namePattern: /^(avatar|avatar_url|profile_image|head_image|user_avatar)$/i,
    reason: "头像字段（含个人图像信息）",
    defaultRule: "不脱敏，仅标记为敏感",
  },
]);

// ============================================================================
// 字段业务语义推断规则
// ============================================================================

/**
 * 字段业务语义推断模式表
 *
 * 基于字段命名 + 类型 + 注释推断业务语义。
 * 命中模式后给出推断语义与置信度。
 */
interface FieldSemanticPattern {
  /** 字段名模式（正则，忽略大小写） */
  readonly namePattern: RegExp;
  /** 推断的业务语义 */
  readonly semantics: string;
  /** 置信度（0~1） */
  readonly confidence: number;
}

/**
 * 字段业务语义模式表
 *
 * 覆盖常见业务字段：
 * - id/uuid：唯一标识符
 * - created_at/created_time：创建时间
 * - updated_at/updated_time：更新时间
 * - deleted_at/deleted_time/is_deleted：软删除标记
 * - status/state：状态字段
 * - amount/price/fee/cost：金额
 * - count/quantity/qty：数量
 * - email/phone/mobile：联系方式
 * - ip/ip_address：IP 地址
 * - url/link：链接
 * - description/remark/note：描述
 */
const FIELD_SEMANTIC_PATTERNS: ReadonlyArray<FieldSemanticPattern> = Object.freeze([
  // 标识符
  { namePattern: /^id$/i, semantics: "唯一标识符", confidence: 0.9 },
  { namePattern: /^(uuid|guid|uid)$/i, semantics: "UUID 全局唯一标识符", confidence: 0.95 },
  { namePattern: /^(\w+)_id$/i, semantics: "外键关联 ID", confidence: 0.85 },
  // 时间字段
  {
    namePattern: /^(created_at|created_time|create_time|gmt_create|created)$/i,
    semantics: "记录创建时间",
    confidence: 0.95,
  },
  {
    namePattern: /^(updated_at|updated_time|update_time|gmt_modified|modified|last_modified)$/i,
    semantics: "记录更新时间",
    confidence: 0.95,
  },
  { namePattern: /^(deleted_at|deleted_time|delete_time|deleted)$/i, semantics: "软删除时间", confidence: 0.9 },
  // 状态字段
  {
    namePattern: /^(status|state|order_status|payment_status|ship_status|user_status|account_status)$/i,
    semantics: "状态字段",
    confidence: 0.95,
  },
  {
    namePattern: /^(is_deleted|is_active|is_enabled|is_disabled|is_locked|is_verified|is_confirmed)$/i,
    semantics: "布尔状态标记",
    confidence: 0.9,
  },
  // 金额字段
  {
    namePattern: /^(amount|total_amount|payment_amount|order_amount|paid_amount|refund_amount|balance_amount)$/i,
    semantics: "金额（货币）",
    confidence: 0.95,
  },
  {
    namePattern: /^(price|unit_price|sale_price|original_price|discount_price|cost_price|purchase_price)$/i,
    semantics: "价格（货币）",
    confidence: 0.95,
  },
  {
    namePattern: /^(fee|handling_fee|service_fee|shipping_fee|platform_fee|commission_fee)$/i,
    semantics: "费用（货币）",
    confidence: 0.9,
  },
  { namePattern: /^(cost|total_cost|unit_cost|production_cost)$/i, semantics: "成本（货币）", confidence: 0.9 },
  // 数量字段
  {
    namePattern: /^(count|total_count|item_count|record_count|user_count|order_count)$/i,
    semantics: "计数",
    confidence: 0.9,
  },
  { namePattern: /^(quantity|qty|total_qty|available_qty|stock_qty|sold_qty)$/i, semantics: "数量", confidence: 0.95 },
  // 联系方式
  { namePattern: /^(email|user_email|contact_email)$/i, semantics: "邮箱地址", confidence: 0.95 },
  {
    namePattern: /^(phone|mobile|telephone|contact_phone|phone_number|mobile_number)$/i,
    semantics: "电话号码",
    confidence: 0.95,
  },
  // 网络地址
  { namePattern: /^(ip|ip_address|client_ip|server_ip|remote_ip|source_ip)$/i, semantics: "IP 地址", confidence: 0.95 },
  {
    namePattern: /^(url|link|website|homepage|callback_url|redirect_url|image_url|avatar_url|file_url)$/i,
    semantics: "URL 链接",
    confidence: 0.9,
  },
  // 描述字段
  {
    namePattern: /^(description|desc|remark|note|comment|memo|detail|details)$/i,
    semantics: "描述/备注",
    confidence: 0.9,
  },
  // 姓名/用户
  {
    namePattern: /^(name|user_name|username|full_name|real_name|nick_name|display_name)$/i,
    semantics: "姓名/用户名",
    confidence: 0.85,
  },
  // 版本号
  {
    namePattern: /^(version|ver|v|revision|build_version|api_version|schema_version)$/i,
    semantics: "版本号",
    confidence: 0.9,
  },
  // 排序字段
  {
    namePattern: /^(sort|sort_order|order_index|display_order|sequence|seq|priority|weight)$/i,
    semantics: "排序权重",
    confidence: 0.85,
  },
  // 类型字段
  {
    namePattern: /^(type|kind|category|category_type|entity_type|object_type|record_type)$/i,
    semantics: "类型/分类",
    confidence: 0.85,
  },
]);

/**
 * 字段业务语义推断置信度规则
 *
 * 综合证据来源的置信度叠加：
 * - 仅命名匹配：0.6
 * - 命名匹配 + SQL COMMENT：0.85
 * - 命名匹配 + ORM 注解：0.8
 * - 命名匹配 + 使用上下文：0.75
 * - 命名匹配 + 多源证据：0.95
 */
const SEMANTIC_CONFIDENCE = Object.freeze({
  NAME_ONLY: 0.6,
  NAME_WITH_COMMENT: 0.85,
  NAME_WITH_ORM: 0.8,
  NAME_WITH_USAGE: 0.75,
  NAME_WITH_MULTI_EVIDENCE: 0.95,
});

// ============================================================================
// 文件扫描忽略目录与扩展名
// ============================================================================

/**
 * 扫描忽略目录（对齐 §5.11.1 L1 全局视野层忽略规则）
 */
const IGNORED_DIRECTORIES: ReadonlyArray<string> = Object.freeze([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "coverage",
  ".idea",
  ".vscode",
]);

/**
 * 扫描支持的源码扩展名
 */
const SOURCE_EXTENSIONS: ReadonlyArray<string> = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".java",
  ".py",
  ".go",
  ".sql",
  ".prisma",
]);

/**
 * ORM 实体文件后缀（用于识别 ORM 实体文件）
 */
const ORM_ENTITY_SUFFIXES: ReadonlyArray<string> = Object.freeze([
  ".entity.ts",
  ".entity.js",
  ".model.ts",
  ".model.js",
  ".schema.ts",
  ".schema.js",
]);

/**
 * 字段使用上下文搜索范围（用于字段业务语义推断）
 *
 * 在以下文件中搜索字段使用模式，作为推断证据：
 * - 服务层：services/ 模块下
 * - 控制器层：controllers/ 模块下
 * - DTO 层：dto/ 模块下
 */
const USAGE_CONTEXT_DIRS: ReadonlyArray<string> = Object.freeze([
  "services",
  "controllers",
  "dto",
  "service",
  "controller",
]);

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 数据字典提取错误
 */
export class DataDictionaryExtractorError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-path：路径非法
   *   - path-not-found：路径不存在
   *   - scan-error：扫描失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind: "invalid-path" | "path-not-found" | "scan-error",
    public readonly detail: string
  ) {
    super(`数据字典提取错误 [${kind}]：${detail}`);
    this.name = "DataDictionaryExtractorError";
  }
}

// ============================================================================
// DataDictionaryExtractor 类
// ============================================================================

/**
 * 数据字典提取器（实现 §5.11.2 K4 业务数据理解）
 *
 * 提供真实提取逻辑（禁止 mock）：
 * - extract：扫描项目根目录，返回 DataDictionary
 * - 多语言枚举/常量类识别（TS/JS/Java/Python/Go）
 * - 字典表识别（基于表名与字段命名模式）
 * - 字段业务语义推断（命名 + SQL COMMENT + ORM 注解 + 使用上下文）
 * - 敏感字段标注（联动 EDM 列级脱敏规则）
 *
 * 使用方式：
 * ```typescript
 * const extractor = new DataDictionaryExtractor();
 * const dict = await extractor.extract("/path/to/project");
 * console.log(dict.enums.length);
 * console.log(dict.sensitiveFields.length);
 * ```
 */
export class DataDictionaryExtractor {
  // ============================ 公共 API ============================

  /**
   * 提取项目数据字典
   *
   * 执行流程：
   * 1. 校验 projectRoot 存在
   * 2. 扫描源码文件，提取枚举/常量类（enums）
   * 3. 扫描 SQL/Prisma/TypeORM schema，识别字典表（dictionaryTables）
   * 4. 基于字段命名 + COMMENT + ORM 注解 + 使用上下文推断字段语义（fieldSemantics）
   * 5. 基于字段名匹配敏感字段模式，标注敏感性级别与脱敏规则（sensitiveFields）
   * 6. 返回冻结的 DataDictionary
   *
   * @param projectRoot 项目根目录
   * @returns 数据字典（含枚举/字典表/字段语义/敏感字段）
   * @throws {DataDictionaryExtractorError} 路径非法或扫描失败时抛出
   */
  async extract(projectRoot: string): Promise<DataDictionary> {
    // 入参校验
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new DataDictionaryExtractorError("invalid-path", "projectRoot 必须为非空字符串");
    }

    // 解析为绝对路径
    const absoluteRoot = path.isAbsolute(projectRoot) ? projectRoot : path.resolve(process.cwd(), projectRoot);

    // 校验路径存在
    let stat;
    try {
      stat = await fs.stat(absoluteRoot);
    } catch (err) {
      throw new DataDictionaryExtractorError(
        "path-not-found",
        `路径不存在：${absoluteRoot}（${(err as Error).message}）`
      );
    }
    if (!stat.isDirectory()) {
      throw new DataDictionaryExtractorError("invalid-path", `projectRoot 必须为目录：${absoluteRoot}`);
    }

    // 1. 扫描所有源码文件
    const sourceFiles: Array<{ readonly absPath: string; readonly relPath: string; readonly ext: string }> = [];
    await this.collectSourceFiles(absoluteRoot, "", sourceFiles, 0, 6);

    // 2. 提取枚举/常量类
    const enums: BusinessEnum[] = [];
    for (const file of sourceFiles) {
      try {
        const content = await fs.readFile(file.absPath, "utf-8");
        const extractedEnums = this.extractEnums(content, file.ext, file.relPath);
        enums.push(...extractedEnums);
      } catch {
        // 读取失败：跳过
        continue;
      }
    }

    // 3. 解析 schema 文件，识别字典表 + 收集所有表字段（供字段语义与敏感字段标注使用）
    const allTables: DatabaseTable[] = [];
    for (const file of sourceFiles) {
      // 仅扫描 SQL/Prisma/TypeORM 文件
      if (![".sql", ".prisma"].includes(file.ext) && !this.isOrmEntityFile(file.relPath)) {
        continue;
      }
      try {
        const content = await fs.readFile(file.absPath, "utf-8");
        const tables = this.parseSchemaTables(content, file.ext, file.relPath);
        allTables.push(...tables);
      } catch {
        continue;
      }
    }

    // 4. 识别字典表
    const dictionaryTables = this.identifyDictionaryTables(allTables);

    // 5. 字段业务语义推断（基于命名 + COMMENT + 使用上下文）
    const fieldSemantics = await this.inferFieldSemantics(allTables, absoluteRoot);

    // 6. 敏感字段标注
    const sensitiveFields = this.identifySensitiveFields(allTables);

    return Object.freeze({
      enums: Object.freeze(enums.map((e) => Object.freeze({ ...e }))),
      dictionaryTables: Object.freeze(dictionaryTables.map((d) => Object.freeze({ ...d }))),
      fieldSemantics: Object.freeze(fieldSemantics.map((f) => Object.freeze({ ...f }))),
      sensitiveFields: Object.freeze(sensitiveFields.map((s) => Object.freeze({ ...s }))),
    });
  }

  // ============================ 私有辅助方法 ============================

  /**
   * 递归收集源码文件
   *
   * @param absoluteDir 当前绝对目录
   * @param relativeDir 当前相对目录
   * @param files 文件收集列表
   * @param depth 当前深度
   * @param maxDepth 最大深度
   */
  private async collectSourceFiles(
    absoluteDir: string,
    relativeDir: string,
    files: Array<{ readonly absPath: string; readonly relPath: string; readonly ext: string }>,
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // 跳过忽略目录
        if (IGNORED_DIRECTORIES.includes(entry.name)) {
          continue;
        }
        const subAbs = path.join(absoluteDir, entry.name);
        const subRel = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        await this.collectSourceFiles(subAbs, subRel, files, depth + 1, maxDepth);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.includes(ext)) {
          continue;
        }
        const absPath = path.join(absoluteDir, entry.name);
        const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        files.push({ absPath, relPath, ext });
      }
    }
  }

  /**
   * 判断文件是否为 ORM 实体文件
   *
   * @param filePath 文件相对路径
   * @returns 是否为 ORM 实体文件
   */
  private isOrmEntityFile(filePath: string): boolean {
    return ORM_ENTITY_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
  }

  /**
   * 从源码内容提取枚举/常量类
   *
   * @param content 源码内容
   * @param ext 文件扩展名
   * @param filePath 文件相对路径
   * @returns 枚举列表
   */
  private extractEnums(content: string, ext: string, filePath: string): BusinessEnum[] {
    const enums: BusinessEnum[] = [];

    for (const rule of ENUM_EXTRACTION_RULES) {
      // 跳过不适用的扩展名
      if (!rule.extensions.includes(ext)) {
        continue;
      }

      // 重置正则 lastIndex（避免全局正则状态污染）
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(content)) !== null) {
        const enumName = match[1];
        const enumBody = match[2];

        // 提取枚举值
        const values = this.extractEnumValues(enumBody, rule.name);

        // 仅当至少含 1 个枚举值时才记录
        if (values.length === 0) {
          continue;
        }

        // 提取枚举描述（从枚举上方注释提取）
        const description = this.extractEnumDescription(content, match.index);

        enums.push(
          Object.freeze({
            enumName,
            values: Object.freeze(values.map((v) => Object.freeze({ ...v }))),
            filePath,
            description,
          })
        );
      }
    }

    return enums;
  }

  /**
   * 从枚举体内提取枚举值列表
   *
   * @param enumBody 枚举体内容（不含外层 { }）
   * @param ruleName 规则名（用于区分语言）
   * @returns 枚举值列表
   */
  private extractEnumValues(enumBody: string, ruleName: string): BusinessEnumValue[] {
    const values: BusinessEnumValue[] = [];

    if (ruleName === "java-enum") {
      // Java 枚举：A, B(args); C(args);
      // 优先用带参数模式提取
      JAVA_ENUM_WITH_ARGS_PATTERN.lastIndex = 0;
      let javaMatch: RegExpExecArray | null;
      let hasArgs = false;
      while ((javaMatch = JAVA_ENUM_WITH_ARGS_PATTERN.exec(enumBody)) !== null) {
        hasArgs = true;
        const memberName = javaMatch[1];
        const args = javaMatch[2].split(",").map((s) => s.trim());
        // 第一个参数视为 value，第二个参数（若有字符串字面量）视为 label
        const value = args[0] || memberName;
        const labelMatch = args[1] ? args[1].match(/^["'](.+?)["']$/) : null;
        const label = labelMatch ? labelMatch[1] : memberName;
        values.push(
          Object.freeze({
            value: value.replace(/["']/g, ""),
            label,
          })
        );
      }
      // 无参数模式：A, B, C
      if (!hasArgs) {
        const members = enumBody
          .split(/[,\n;{}]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && /^[A-Z_][A-Z0-9_]*$/.test(s));
        for (const m of members) {
          values.push(
            Object.freeze({
              value: m,
              label: m,
            })
          );
        }
      }
      return values;
    }

    if (ruleName === "go-const-enum") {
      // Go 枚举：A X = iota, B, C, D
      const lines = enumBody
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      let iotaValue = 0;
      for (const line of lines) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s+(?:[A-Z][a-zA-Z0-9_]*)?\s*=\s*(?:(iota)|(\d+))?/);
        if (!m) continue;
        const memberName = m[1];
        const value = m[2] ? String(iotaValue) : m[3] || memberName;
        values.push(
          Object.freeze({
            value,
            label: memberName,
          })
        );
        iotaValue++;
      }
      return values;
    }

    // TypeScript/JavaScript/Python：通用模式 A = value 或 A: value
    const lines = enumBody
      .split(/[,\n]/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
      // 跳过方法定义、装饰器、注释行
      if (/^(\/\/|#|\/\*|\*)/.test(line)) continue;
      if (
        /^(async\s+|static\s+|public\s+|private\s+|protected\s+)?[a-z_]/.test(line) &&
        !line.includes("=") &&
        !line.includes(":")
      ) {
        continue;
      }

      // 模式 1：NAME = value 或 NAME: value
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*[:=]\s*([^,\n;]+?)(?:\s*\/\/\s*(.+)|\s*#\s*(.+))?$/);
      if (m) {
        const memberName = m[1];
        const value = m[2].trim().replace(/["'`]/g, "");
        const comment = m[3] || m[4];
        values.push(
          Object.freeze({
            value,
            label: comment || memberName,
            comment: comment || undefined,
          })
        );
        continue;
      }

      // 模式 2：仅 NAME（无显式值，TS enum 隐式从 0 递增）
      const m2 = line.match(/^([A-Z_][A-Z0-9_]*)\s*(?:\/\/\s*(.+)|#\s*(.+))?$/);
      if (m2) {
        const memberName = m2[1];
        const comment = m2[2] || m2[3];
        values.push(
          Object.freeze({
            value: String(values.length),
            label: comment || memberName,
            comment: comment || undefined,
          })
        );
      }
    }

    return values;
  }

  /**
   * 从枚举上方注释提取枚举描述
   *
   * 支持：
   * - 单行注释 // xxx 或 # xxx
   * - 多行注释块（slash-star ... star-slash）
   * - JSDoc 注释块（slash-star-star ... star-slash）
   *
   * 注释与枚举之间允许出现修饰关键字（export/public/private/protected/abstract/final/static/declare），
   * 以适配常见的"注释 + 修饰关键字 + enum"写法。
   *
   * @param content 文件内容
   * @param enumIndex 枚举在文件中的起始位置（即 enum/class/const 关键字位置）
   * @returns 枚举描述（无注释返回空字符串）
   */
  private extractEnumDescription(content: string, enumIndex: number): string {
    // 取枚举前 200 个字符的片段
    const prefix = content.slice(Math.max(0, enumIndex - 200), enumIndex);

    // 匹配最近的 JSDoc/多行注释
    // 注：原 pattern 要求注释后只有空白到 prefix 末尾，
    // 但 TS enum 的 match.index 是 enum 关键字位置，prefix 末尾会包含 export 等修饰关键字，
    // 导致 \s*$ 匹配失败。修复后允许注释后出现修饰关键字序列（export/public/private 等）。
    const multiLineMatch = prefix.match(
      /\/\*\*?\s*([\s\S]*?)\*\/[\s\n]*(?:(?:export|public|private|protected|abstract|final|static|declare|open|sealed)\s+)*$/
    );
    if (multiLineMatch) {
      // 提取注释正文（去除每行前导 *）
      const text = multiLineMatch[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\*\s?/, "").trim())
        .filter((l) => l.length > 0)
        .join(" ");
      return text;
    }

    // 匹配最近的连续单行注释
    // 同样允许注释后出现修饰关键字序列
    const lines = prefix.split("\n");
    const commentLines: string[] = [];
    let reachedModifier = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      const singleMatch = line.match(/^(?:\/\/|#)\s*(.+)$/);
      if (singleMatch) {
        commentLines.unshift(singleMatch[1]);
        reachedModifier = false; // 进入注释区，重置修饰关键字标志
      } else if (
        !reachedModifier &&
        /^(?:export|public|private|protected|abstract|final|static|declare|open|sealed)$/.test(line)
      ) {
        // 允许修饰关键字行（如 export / public 等）
        continue;
      } else if (line.length === 0) {
        // 空行允许
        continue;
      } else {
        break;
      }
    }
    return commentLines.join(" ");
  }

  /**
   * 解析 schema 文件，返回 DatabaseTable 列表
   *
   * 复用 K3 DatabaseSchemaAnalyzer 的部分解析能力，但内联实现避免循环依赖。
   *
   * @param content schema 内容
   * @param ext 文件扩展名
   * @param filePath 文件路径
   * @returns 表列表
   */
  private parseSchemaTables(content: string, ext: string, filePath: string): DatabaseTable[] {
    if (ext === ".sql") {
      return this.parseSqlDdl(content);
    }
    if (ext === ".prisma") {
      return this.parsePrismaSchema(content);
    }
    if (this.isOrmEntityFile(filePath)) {
      return this.parseTypeOrmEntity(content, filePath);
    }
    return [];
  }

  /**
   * 解析 SQL DDL（CREATE TABLE 语句）
   *
   * @param content SQL 内容
   * @returns 表列表
   */
  private parseSqlDdl(content: string): DatabaseTable[] {
    const tables: DatabaseTable[] = [];
    const pattern =
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\(([\s\S]*?)\)\s*;/gi;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const tableName = match[1];
      const tableBody = match[2];

      // 提取表注释
      const tableCommentMatch = content.slice(match.index).match(/COMMENT\s*=\s*['"]([^'"]+)['"]/i);
      const tableComment = tableCommentMatch ? tableCommentMatch[1] : undefined;

      // 解析字段
      const columns = this.parseSqlColumns(tableBody);
      const indexes = this.parseSqlIndexes(tableBody, tableName);
      const foreignKeys = this.parseSqlForeignKeys(tableBody, tableName);

      tables.push(
        Object.freeze({
          tableName,
          comment: tableComment,
          columns: Object.freeze(columns.map((c) => Object.freeze({ ...c }))),
          indexes: Object.freeze(indexes.map((i) => Object.freeze({ ...i }))),
          foreignKeys: Object.freeze(foreignKeys.map((f) => Object.freeze({ ...f }))),
        })
      );
    }
    return tables;
  }

  /**
   * 解析 SQL 字段定义
   *
   * @param tableBody 表体（含字段与约束）
   * @returns 字段列表
   */
  private parseSqlColumns(tableBody: string): Array<{
    columnName: string;
    dataType: string;
    nullable: boolean;
    defaultValue?: string;
    comment?: string;
    isPrimaryKey: boolean;
    isUnique: boolean;
  }> {
    const columns: Array<{
      columnName: string;
      dataType: string;
      nullable: boolean;
      defaultValue?: string;
      comment?: string;
      isPrimaryKey: boolean;
      isUnique: boolean;
    }> = [];

    const lines = tableBody
      .split(",")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    for (const line of lines) {
      // 跳过约束行
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX)/i.test(line)) {
        continue;
      }
      const colMatch = line.match(/^\s*[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s+([A-Z]+(?:\s*\([^)]*\))?)([^,]*)/i);
      if (!colMatch) continue;

      const columnName = colMatch[1];
      const dataType = colMatch[2].trim();
      const restPart = colMatch[3] || "";
      const isPrimaryKey = /PRIMARY\s+KEY/i.test(restPart);
      const isUnique = /UNIQUE/i.test(restPart);
      const nullable = !/NOT\s+NULL/i.test(restPart);
      const defaultValueMatch = restPart.match(/DEFAULT\s+([^\s,]+)/i);
      const defaultValue = defaultValueMatch ? defaultValueMatch[1] : undefined;
      const commentMatch = line.match(/COMMENT\s+['"]([^'"]+)['"]/i);
      const comment = commentMatch ? commentMatch[1] : undefined;

      columns.push({
        columnName,
        dataType,
        nullable,
        defaultValue,
        comment,
        isPrimaryKey,
        isUnique,
      });
    }
    return columns;
  }

  /**
   * 解析 SQL 索引（PRIMARY KEY）
   *
   * @param tableBody 表体
   * @param tableName 表名
   * @returns 索引列表
   */
  private parseSqlIndexes(
    tableBody: string,
    tableName: string
  ): Array<{
    indexName: string;
    columnNames: string[];
    isUnique: boolean;
    isPrimary: boolean;
  }> {
    const indexes: Array<{
      indexName: string;
      columnNames: string[];
      isUnique: boolean;
      isPrimary: boolean;
    }> = [];
    const pkPattern = /PRIMARY\s+KEY\s*\(([^)]+)\)/gi;
    pkPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pkPattern.exec(tableBody)) !== null) {
      const pkColumns = match[1].split(",").map((c) => c.trim().replace(/[`"]/g, ""));
      indexes.push({
        indexName: `pk_${tableName}`,
        columnNames: pkColumns,
        isUnique: true,
        isPrimary: true,
      });
    }
    return indexes;
  }

  /**
   * 解析 SQL 外键
   *
   * @param tableBody 表体
   * @param tableName 表名
   * @returns 外键列表
   */
  private parseSqlForeignKeys(
    tableBody: string,
    tableName: string
  ): Array<{
    foreignKeyName: string;
    columnName: string;
    referencedTableName: string;
    referencedColumnName: string;
  }> {
    const foreignKeys: Array<{
      foreignKeyName: string;
      columnName: string;
      referencedTableName: string;
      referencedColumnName: string;
    }> = [];
    const fkPattern =
      /FOREIGN\s+KEY\s*[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\([`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\)\s*REFERENCES\s*[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*\([`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\)/gi;
    fkPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = fkPattern.exec(tableBody)) !== null) {
      foreignKeys.push({
        foreignKeyName: match[1] || `fk_${tableName}_${match[2]}`,
        columnName: match[2],
        referencedTableName: match[3],
        referencedColumnName: match[4],
      });
    }
    return foreignKeys;
  }

  /**
   * 解析 Prisma schema
   *
   * @param content Prisma schema 内容
   * @returns 表列表
   */
  private parsePrismaSchema(content: string): DatabaseTable[] {
    const tables: DatabaseTable[] = [];
    const modelPattern = /\bmodel\s+([A-Z][a-zA-Z0-9_]*)\s*\{([\s\S]*?)\}/g;
    modelPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = modelPattern.exec(content)) !== null) {
      const modelName = match[1];
      const modelBody = match[2];

      // 解析 @@map("table_name")
      const mapMatch = modelBody.match(/@@map\(["']([^"']+)["']\)/);
      const tableName = mapMatch ? mapMatch[1] : modelName.toLowerCase();

      // 解析字段
      const columns: Array<{
        columnName: string;
        dataType: string;
        nullable: boolean;
        defaultValue?: string;
        comment?: string;
        isPrimaryKey: boolean;
        isUnique: boolean;
      }> = [];
      const fieldLines = modelBody
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("@@"));

      for (const line of fieldLines) {
        const fieldMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+([A-Za-z]+(?:\[\])?)([^]*)$/);
        if (!fieldMatch) continue;
        const columnName = fieldMatch[1];
        const dataType = fieldMatch[2];
        const restPart = fieldMatch[3] || "";
        const isPrimaryKey = /@id/i.test(restPart);
        const isUnique = /@unique/i.test(restPart);
        const nullable = !/!/.test(dataType);
        const defaultValueMatch = restPart.match(/@default\s*\(\s*([^)]+)\s*\)/i);
        const defaultValue = defaultValueMatch ? defaultValueMatch[1] : undefined;
        const commentMatch = restPart.match(/\/\/\s*(.+)$/);
        const comment = commentMatch ? commentMatch[1].trim() : undefined;

        columns.push({
          columnName,
          dataType,
          nullable,
          defaultValue,
          comment,
          isPrimaryKey,
          isUnique,
        });
      }

      tables.push(
        Object.freeze({
          tableName,
          comment: `Prisma model ${modelName}`,
          columns: Object.freeze(columns.map((c) => Object.freeze({ ...c }))),
          indexes: Object.freeze([]),
          foreignKeys: Object.freeze([]),
        })
      );
    }
    return tables;
  }

  /**
   * 解析 TypeORM 实体文件
   *
   * @param content 实体文件内容
   * @param _filePath 文件路径（预留参数，当前实现仅基于 content 解析，后续扩展文件级元数据时使用）
   * @returns 表列表
   */
  private parseTypeOrmEntity(content: string, _filePath: string): DatabaseTable[] {
    const tables: DatabaseTable[] = [];
    const entityPattern =
      /@Entity\s*\(\s*['"`]?([a-zA-Z_][a-zA-Z0-9_]*)['"`]?\s*\)\s*(?:export\s+)?class\s+([A-Z][a-zA-Z0-9_]*)/g;
    entityPattern.lastIndex = 0;
    let entityMatch: RegExpExecArray | null;
    while ((entityMatch = entityPattern.exec(content)) !== null) {
      const tableName = entityMatch[1];
      const className = entityMatch[2];

      const columns: Array<{
        columnName: string;
        dataType: string;
        nullable: boolean;
        defaultValue?: string;
        comment?: string;
        isPrimaryKey: boolean;
        isUnique: boolean;
      }> = [];

      // @PrimaryColumn / @PrimaryGeneratedColumn
      const primaryPattern =
        /@(?:PrimaryColumn|PrimaryGeneratedColumn)\s*(?:\(\s*\{([^}]*)\}\s*\))?\s*(?:[a-zA-Z]+)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([A-Za-z]+)/g;
      primaryPattern.lastIndex = 0;
      let pkMatch: RegExpExecArray | null;
      while ((pkMatch = primaryPattern.exec(content)) !== null) {
        const columnName = pkMatch[2];
        const dataType = pkMatch[3];
        const options = pkMatch[1] || "";
        const nullable = /nullable:\s*true/i.test(options);
        const commentMatch = options.match(/comment:\s*['"]([^'"]+)['"]/i);
        const comment = commentMatch ? commentMatch[1] : undefined;
        columns.push({
          columnName,
          dataType,
          nullable,
          comment,
          isPrimaryKey: true,
          isUnique: false,
        });
      }

      // @Column
      const columnPattern =
        /@Column\s*(?:\(\s*\{([^}]*)\}\s*\))?\s*(?:[a-zA-Z]+)?\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([A-Za-z]+)/g;
      columnPattern.lastIndex = 0;
      let colMatch: RegExpExecArray | null;
      while ((colMatch = columnPattern.exec(content)) !== null) {
        const columnName = colMatch[2];
        const dataType = colMatch[3];
        const options = colMatch[1] || "";
        const nullable = /nullable:\s*true/i.test(options);
        const isUnique = /unique:\s*true/i.test(options);
        const defaultValueMatch = options.match(/default:\s*([^,\s]+)/i);
        const defaultValue = defaultValueMatch ? defaultValueMatch[1] : undefined;
        const commentMatch = options.match(/comment:\s*['"]([^'"]+)['"]/i);
        const comment = commentMatch ? commentMatch[1] : undefined;
        columns.push({
          columnName,
          dataType,
          nullable,
          defaultValue,
          comment,
          isPrimaryKey: false,
          isUnique,
        });
      }

      tables.push(
        Object.freeze({
          tableName,
          comment: `TypeORM entity ${className}`,
          columns: Object.freeze(columns.map((c) => Object.freeze({ ...c }))),
          indexes: Object.freeze([]),
          foreignKeys: Object.freeze([]),
        })
      );
    }
    return tables;
  }

  /**
   * 识别字典表
   *
   * 判定规则：
   * 1. 表名匹配字典表名模式（含 dict/dictionary/type/config 关键词）
   * 2. 表含 key 列（code/key/value_code/id）+ value 列（name/label/desc）
   *
   * @param tables 已识别的全部表
   * @returns 字典表列表
   */
  private identifyDictionaryTables(tables: ReadonlyArray<DatabaseTable>): DictionaryTable[] {
    const dictionaryTables: DictionaryTable[] = [];

    for (const table of tables) {
      // 检查表名是否匹配字典表模式
      const nameMatch = DICTIONARY_TABLE_NAME_PATTERNS.some((p) => p.test(table.tableName));

      // 检查字段是否含 key/value 模式
      let keyColumn = "";
      let valueColumn = "";
      for (const col of table.columns) {
        if (!keyColumn && DICTIONARY_KEY_COLUMN_PATTERNS.some((p) => p.test(col.columnName))) {
          keyColumn = col.columnName;
        }
        if (!valueColumn && DICTIONARY_VALUE_COLUMN_PATTERNS.some((p) => p.test(col.columnName))) {
          valueColumn = col.columnName;
        }
      }

      // 满足以下任一条件视为字典表：
      // 1. 表名匹配 + 含 key 列 + 含 value 列
      // 2. 表名匹配 + 含 key 列（弱判定）
      // 3. 含 key 列 + 含 value 列 + 表名含小字典相关词
      const isDictionaryTable =
        (nameMatch && keyColumn && valueColumn) ||
        (nameMatch && keyColumn) ||
        (keyColumn && valueColumn && /\b(dict|dictionary|enum|type|config)\b/i.test(table.tableName));

      if (isDictionaryTable) {
        // 推断描述（基于表注释或表名）
        const description = table.comment || `字典表 ${table.tableName}`;
        // 推断文件路径（基于表名模式）
        const filePath = this.guessOrmFilePath(table.tableName);

        dictionaryTables.push(
          Object.freeze({
            tableName: table.tableName,
            keyColumn: keyColumn || "code",
            valueColumn: valueColumn || "name",
            description,
            filePath,
          })
        );
      }
    }

    return dictionaryTables;
  }

  /**
   * 基于 tableName 猜测 ORM 实体文件路径
   *
   * @param tableName 表名
   * @returns 推断的 ORM 实体文件路径
   */
  private guessOrmFilePath(tableName: string): string {
    // 将 snake_case 转 PascalCase
    const pascal = tableName
      .split("_")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("");
    return `src/entities/${pascal}.entity.ts`;
  }

  /**
   * 推断字段业务语义
   *
   * 综合证据：
   * 1. 字段命名匹配 FIELD_SEMANTIC_PATTERNS
   * 2. SQL COMMENT / Prisma 注释 / ORM @Comment 注解
   * 3. 使用上下文（在 services/controllers/dto 中搜索字段使用）
   *
   * @param tables 已识别的全部表
   * @param projectRoot 项目根目录
   * @returns 字段语义列表
   */
  private async inferFieldSemantics(
    tables: ReadonlyArray<DatabaseTable>,
    projectRoot: string
  ): Promise<FieldSemantics[]> {
    const fieldSemantics: FieldSemantics[] = [];

    // 收集使用上下文（仅在 services/controllers/dto 目录搜索）
    const usageContextMap = await this.collectUsageContext(projectRoot);

    for (const table of tables) {
      for (const col of table.columns) {
        const evidence: string[] = [];
        let confidence = 0;
        let inferredSemantics = "";

        // 证据 1：字段命名匹配
        const nameMatch = FIELD_SEMANTIC_PATTERNS.find((p) => p.namePattern.test(col.columnName));
        if (nameMatch) {
          inferredSemantics = nameMatch.semantics;
          confidence = SEMANTIC_CONFIDENCE.NAME_ONLY;
          evidence.push(`命名匹配模式：${col.columnName} → ${nameMatch.semantics}`);
        }

        // 证据 2：SQL COMMENT / Prisma 注释 / ORM @Comment 注解
        if (col.comment) {
          if (!inferredSemantics) {
            inferredSemantics = col.comment;
          }
          confidence = Math.max(confidence, SEMANTIC_CONFIDENCE.NAME_WITH_COMMENT);
          evidence.push(`字段注释：${col.comment}`);
        }

        // 证据 3：使用上下文（搜索 services/controllers/dto 中的字段使用）
        const usageContext = usageContextMap.get(col.columnName.toLowerCase());
        if (usageContext && usageContext.length > 0) {
          if (!inferredSemantics) {
            // 使用上下文无法直接给出语义，但作为证据
            inferredSemantics = `${col.columnName}（在 ${usageContext[0]} 中使用）`;
          }
          confidence = Math.max(confidence, SEMANTIC_CONFIDENCE.NAME_WITH_USAGE);
          evidence.push(`使用上下文：${usageContext.slice(0, 3).join(", ")}`);
        }

        // 多源证据提升置信度
        if (evidence.length >= 2) {
          confidence = Math.max(confidence, SEMANTIC_CONFIDENCE.NAME_WITH_MULTI_EVIDENCE);
        }

        // 仅当能推断出语义时记录
        if (inferredSemantics && confidence > 0) {
          fieldSemantics.push(
            Object.freeze({
              tableName: table.tableName,
              columnName: col.columnName,
              inferredSemantics,
              evidence: Object.freeze(evidence),
              confidence,
            })
          );
        }
      }
    }

    return fieldSemantics;
  }

  /**
   * 收集字段使用上下文
   *
   * 在 services/controllers/dto 目录下搜索字段名出现位置作为使用上下文证据。
   *
   * @param projectRoot 项目根目录
   * @returns 字段名（小写）→ 使用位置列表
   */
  private async collectUsageContext(projectRoot: string): Promise<Map<string, string[]>> {
    const usageMap = new Map<string, string[]>();

    for (const dirName of USAGE_CONTEXT_DIRS) {
      const dirPath = path.join(projectRoot, dirName);
      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      // 扫描目录下的文件
      const files: string[] = [];
      await this.collectFilesFlat(dirPath, files);

      for (const filePath of files) {
        let content: string;
        try {
          content = await fs.readFile(filePath, "utf-8");
        } catch {
          continue;
        }
        // 提取所有 camelCase / snake_case 标识符
        const identifierPattern = /\b([a-z_][a-zA-Z0-9_]+)\b/g;
        let idMatch: RegExpExecArray | null;
        const seenInFile = new Set<string>();
        while ((idMatch = identifierPattern.exec(content)) !== null) {
          const id = idMatch[1].toLowerCase();
          if (id.length < 3) continue; // 跳过过短标识符
          if (seenInFile.has(id)) continue;
          seenInFile.add(id);
          const relPath = path.relative(projectRoot, filePath);
          const list = usageMap.get(id) || [];
          list.push(relPath);
          usageMap.set(id, list);
        }
      }
    }

    return usageMap;
  }

  /**
   * 平铺式收集目录下的源码文件（不递归子目录）
   *
   * @param absoluteDir 目录绝对路径
   * @param files 文件路径收集列表
   */
  private async collectFilesFlat(absoluteDir: string, files: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.includes(ext)) continue;
        files.push(path.join(absoluteDir, entry.name));
      }
    }
  }

  /**
   * 识别敏感字段
   *
   * 基于字段名匹配 SENSITIVE_FIELD_PATTERNS 模式表。
   * 命中后给出敏感性级别、判定原因、默认脱敏规则。
   *
   * @param tables 已识别的全部表
   * @returns 敏感字段列表
   */
  private identifySensitiveFields(tables: ReadonlyArray<DatabaseTable>): SensitiveField[] {
    const sensitiveFields: SensitiveField[] = [];

    for (const table of tables) {
      for (const col of table.columns) {
        // 遍历敏感字段模式表（按 sensitivity 优先级排序）
        for (const pattern of SENSITIVE_FIELD_PATTERNS) {
          if (pattern.namePattern.test(col.columnName)) {
            sensitiveFields.push(
              Object.freeze({
                tableName: table.tableName,
                columnName: col.columnName,
                sensitivity: pattern.sensitivity,
                reason: pattern.reason,
                desensitizationRule: pattern.defaultRule,
              })
            );
            // 命中后跳出模式循环（避免重复标注）
            break;
          }
        }
      }
    }

    return sensitiveFields;
  }
}
