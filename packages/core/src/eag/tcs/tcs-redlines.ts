/**
 * TCS 技术组件规范红线清单（TCS-OSS-01~03 / TCS-CACHE-01~03 / TCS-SQL-01~03 / TCS-LDAP-01~02 / TCS-SEC-01~02）
 *
 * 实现 EAG 方案 §5.8.1~§5.8.5 各子节的红线清单：
 * 将企业技术组件规范（对象存储 / 缓存 / SQL 优化 / LDAP 接入 / 漏洞扫描）的红线
 * 结构化为 RedlineDefinition，作为评估器 Verification 阶段的判定清单。
 *
 * 红线清单（13 条，对齐 §5.8 各子节）：
 * | ID           | 名称                           | 级别     | 判定方式                                          |
 * |--------------|--------------------------------|----------|--------------------------------------------------|
 * | TCS-OSS-01   | 业务代码直连具体厂商 SDK        | blocker  | import 静态分析（业务代码禁止 import aws-sdk 等）  |
 * | TCS-OSS-02   | 签名 URL 过期时间 >24h         | major    | 静态扫描 signedUrl 调用的 expirySeconds 参数       |
 * | TCS-OSS-03   | 文件类型/大小未校验直接上传     | blocker  | 静态扫描 put 调用前的校验逻辑存在性                |
 * | TCS-CACHE-01 | 缓存无 TTL                      | major    | 静态扫描 cache.set 调用的 ttlSeconds 参数          |
 * | TCS-CACHE-02 | 缓存与 DB 双写顺序错误          | blocker  | 静态扫描双写顺序（禁"先删缓存"，必须"先更库后删"）  |
 * | TCS-CACHE-03 | 缓存穿透无防护                  | major    | 静态扫描空值缓存/布隆过滤器存在性                   |
 * | TCS-SQL-01   | 全表扫描（无索引覆盖的 WHERE）  | blocker  | EXPLAIN 验证（测试库数据量下）                     |
 * | TCS-SQL-02   | 循环内单条查询（N+1）           | major    | 静态扫描 ORM 查询模式（循环 + 单条查询调用）       |
 * | TCS-SQL-03   | 深分页 offset 滥用              | major    | 静态扫描 SQL 语句的 OFFSET 参数（>10000 违规）     |
 * | TCS-LDAP-01  | 直连 LDAP 实时查询无缓存        | major    | 静态扫描登录流程是否走本地镜像/缓存                |
 * | TCS-LDAP-02  | 同步任务无幂等                  | blocker  | 静态扫描同步任务的幂等键参数                       |
 * | TCS-SEC-01   | 高危依赖漏洞未修复即放行        | blocker  | npm audit / OWASP Dependency-Check 扫描            |
 * | TCS-SEC-02   | 扫描出硬编码密钥                | blocker  | gitleaks 静态扫描                                  |
 *
 * 复用关系：
 * - 复用 EAG-P0 `packages/core/src/eag/evaluator/types.ts` 的 RedlineDefinition 接口
 * - 红线级别使用 P0 已定义的 RedlineSeverity 类型（小写形式 "blocker" / "major" / "warning"）
 * - 本模块仅定义红线"规则"，不实现"判定逻辑"（判定逻辑由 IndependentEvaluator 实现方提供）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - TCS_REDLINES 使用 ReadonlyArray + Object.freeze 冻结
 * - 防止运行期被 LLM 自改
 *
 * @module eag/tcs/tcs-redlines
 */

import type { RedlineDefinition, RedlineSeverity } from "../evaluator/types";
import type { TcsRedlineId, TcsRedlineCategory } from "./types";
import { TCS_REDLINE_IDS, TCS_REDLINE_CATEGORIES } from "./types";

// ============================================================================
// 13 条 TCS 红线定义
// ============================================================================

/**
 * TCS 红线清单（13 条）
 *
 * 13 条红线按 §5.8.1~§5.8.5 顺序定义，使用 ReadonlyArray + Object.freeze 冻结，
 * 防止运行期被修改（评估器判定清单不可被 LLM 自改，对齐 §5.12.4 G-A6d 配置冻结原则）。
 *
 * 不可变性说明：
 * - 外层数组通过 Object.freeze 冻结（禁止 push / pop / 修改长度）
 * - 每个元素（RedlineDefinition 对象）通过 .map(Object.freeze) 逐个冻结
 *   （禁止修改元素的 id / severity 等字段，对齐 R12 测试"修改字段应抛错"）
 * - Object.freeze 为浅冻结，但 RedlineDefinition 仅含 string 字段（无嵌套对象），
 *   故浅冻结已足够保证不可变性
 *
 * 字段说明（对齐 RedlineDefinition）：
 * - id：红线唯一 ID（"TCS-OSS-01" 等）
 * - name：红线名称（中文，便于审计日志）
 * - description：详细描述（什么场景触发、为什么重要）
 * - severity：级别（blocker / major / warning）
 * - checkMethod：判定方式描述（评估器实现方据此选择判定算法）
 * - checkType：判定方式类型（static 静态可判 / reasoning 推理判定）
 * - fixGuidance：修复建议模板（评估器判定不通过时附带）
 */
export const TCS_REDLINES: ReadonlyArray<RedlineDefinition> = Object.freeze(
  // 先对每个 RedlineDefinition 对象执行 Object.freeze，再冻结外层数组。
  // 这样既能阻止数组层面的增删（push/pop），也能阻止元素层面的字段修改
  // （r.id = "x" 会抛 TypeError），对齐 R12 不可变性测试要求。
  (
    [
      // ==========================================================================
      // 对象存储红线（§5.8.1）
      // ==========================================================================

      // TCS-OSS-01：业务代码直连具体厂商 SDK
      {
        id: "TCS-OSS-01",
        name: "业务代码直连具体厂商 SDK",
        description:
          "业务代码只允许依赖 ObjectStoragePort 抽象接口，禁止直接 import 具体厂商 SDK（如 aws-sdk、ali-oss、minio）。" +
          "供应商锁定是企业架构的反模式——业务代码直接依赖具体 SDK 后，迁移存储供应商（如从 S3 迁移到 OSS）" +
          "需要修改大量业务代码，违反 DIP（依赖倒置原则）与 §5.8.1 规范的统一抽象要求。" +
          "正确做法：业务代码通过依赖注入获取 ObjectStoragePort，由适配器层（S3Adapter / OssAdapter / MinioAdapter）" +
          "封装具体厂商 SDK 调用。",
        severity: "blocker",
        checkMethod:
          "import 静态分析——扫描业务代码（非 tcs/object-storage.ts 适配器文件）是否 import aws-sdk / ali-oss / minio 等 SDK；" +
          "业务代码应仅 import { ObjectStoragePort } from 'eag/tcs/object-storage'，禁止直接 import 厂商 SDK。",
        checkType: "static",
        fixGuidance:
          "1. 识别业务代码中直接 import 厂商 SDK 的位置（搜索 import.*aws-sdk|ali-oss|minio）\n" +
          "2. 将业务代码改为依赖注入 ObjectStoragePort 接口（构造函数注入或工厂方法获取）\n" +
          "3. 在 IoC 容器中注册适配器（如 createObjectStorage(provider: 's3', config)）\n" +
          "4. 删除业务代码中的 aws-sdk / ali-oss / minio import 语句\n" +
          "5. 业务代码调用 port.put() / port.get() / port.signedUrl() 等抽象方法",
      },

      // TCS-OSS-02：签名 URL 过期时间 >24h
      {
        id: "TCS-OSS-02",
        name: "签名 URL 过期时间 >24h",
        description:
          "签名 URL 的过期时间必须 ≤24 小时（86400 秒），禁止设置 >24h 的过期时间。" +
          "签名 URL 是访问私有文件的临时凭证——过期时间过长将导致 URL 泄漏后攻击者可长时间访问文件。" +
          "默认推荐 15 分钟过期（DEFAULT_SIGNED_URL_EXPIRY_SECONDS=900），最大允许 24 小时（MAX_SIGNED_URL_EXPIRY_SECONDS=86400）。",
        severity: "major",
        checkMethod:
          "静态扫描 signedUrl 调用的 expirySeconds 参数——若 >86400（24 小时）则违规。" +
          "扫描模式：port.signedUrl(key, { expirySeconds: <number> }) 与 generateSignedUrl(key, <number>) 调用。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的 signedUrl 调用，检查 expirySeconds 参数\n" +
          "2. 将 expirySeconds 调整为 ≤86400（24 小时）\n" +
          "3. 推荐使用默认值 900（15 分钟）——敏感文件应使用更短的过期时间\n" +
          "4. 若业务确需长时间访问，改为后端代理下载（业务代码读对象存储后转发给客户端）",
      },

      // TCS-OSS-03：文件类型/大小未校验直接上传
      {
        id: "TCS-OSS-03",
        name: "文件类型/大小未校验直接上传",
        description:
          "上传文件前必须校验文件扩展名（白名单）与文件大小（上限），禁止未校验直接上传。" +
          "未校验将导致：(1) 恶意用户上传可执行文件（.exe / .sh）攻击其他用户；" +
          "(2) 上传超大文件耗尽存储空间与带宽；" +
          "(3) 上传伪装文件（扩展名 .jpg 但实际为 .exe）绕过类型限制。" +
          "正确做法：业务代码调用 port.put() 前通过 validateFileExtension + validateFileSize 校验，" +
          "或通过 PutOptions.allowedExtensions + PutOptions.maxSizeBytes 委托适配器校验。",
        severity: "blocker",
        checkMethod:
          "静态扫描 put 调用前的校验逻辑存在性——" +
          "(1) 检查 port.put() 调用前是否调用 validateFileExtension / validateFileSize；" +
          "(2) 或检查 PutOptions.allowedExtensions / PutOptions.maxSizeBytes 是否显式提供；" +
          "(3) 若无任何校验逻辑则违规。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的 put 调用（搜索 port.put\\( / objectStorage.put\\(）\n" +
          "2. 在 put 调用前添加校验逻辑：\n" +
          "   - validateFileExtension(filename, ['jpg', 'png', 'pdf']) // 白名单校验\n" +
          "   - validateFileSize(fileSize, 10 * 1024 * 1024) // 上限 10MB\n" +
          "3. 或通过 PutOptions 委托适配器校验：\n" +
          "   port.put(content, keyParams, { allowedExtensions: ['jpg', 'png'], maxSizeBytes: 10 * 1024 * 1024 })\n" +
          "4. 添加单元测试覆盖校验逻辑（违规扩展名/超限大小应抛错）",
      },

      // ==========================================================================
      // 缓存红线（§5.8.2）
      // ==========================================================================

      // TCS-CACHE-01：缓存无 TTL
      {
        id: "TCS-CACHE-01",
        name: "缓存无 TTL",
        description:
          "所有缓存 key 必须显式设置 TTL（ttlSeconds > 0），禁止无 TTL 的永久缓存（豁免清单除外）。" +
          "无 TTL 的 key 会导致：(1) Redis 内存无限增长最终 OOM；" +
          "(2) 缓存数据与 DB 数据长期不一致（数据更新后缓存未失效）；" +
          "(3) 业务异常时无法通过等待 TTL 过期自愈。" +
          "豁免场景（如配置类静态数据）必须显式加入 ttlExemptKeys 豁免清单，并设置 ttlExempt=true。",
        severity: "major",
        checkMethod:
          "静态扫描 cache.set / port.set 调用——" +
          "(1) 检查 CacheSetOptions.ttlSeconds 是否 >0；" +
          "(2) 若 ttlExempt=true 则检查 key 是否在 ttlExemptKeys 清单内；" +
          "(3) 若 ttlSeconds 缺失或 ≤0 且未声明 ttlExempt 则违规。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的 cache.set 调用，检查 ttlSeconds 参数\n" +
          "2. 显式提供 ttlSeconds（推荐 60~600 秒）：\n" +
          "   await cache.set(keyParams, value, { ttlSeconds: 300 })\n" +
          "3. 若为永久缓存（如配置数据），将 key 加入 ttlExemptKeys 清单并声明 ttlExempt：\n" +
          "   await cache.set(keyParams, value, { ttlExempt: true })\n" +
          "4. 定期审计 ttlExemptKeys 清单（避免滥用）",
      },

      // TCS-CACHE-02：缓存与 DB 双写顺序错误
      {
        id: "TCS-CACHE-02",
        name: "缓存与 DB 双写顺序错误",
        description:
          "缓存与 DB 双写必须遵循「先更库后删缓存」顺序，禁止「先删缓存后更库」。" +
          "错误的顺序会导致缓存与 DB 不一致：\n" +
          "  线程 A 删除缓存 → 线程 B 读取缓存未命中从 DB 加载旧值回填 → 线程 A 更新 DB\n" +
          "  此时缓存为旧值，DB 为新值，不一致。" +
          "正确做法：调用 port.doubleWrite(keyParams, dbUpdater)，由 CachePort 强制「先更库后删缓存」顺序。" +
          "禁止业务代码手动实现 cache.delete() + db.update() 的组合（顺序易错）。",
        severity: "blocker",
        checkMethod:
          "静态扫描双写代码——" +
          "(1) 检查是否存在 cache.delete() 在 db.update() 之前的代码模式（违规）；" +
          "(2) 业务代码应通过 port.doubleWrite() 委托 CachePort 处理双写顺序；" +
          "(3) 若业务代码手动实现双写，必须严格保证 db.update() 在 cache.delete() 之前。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的双写代码（搜索 cache.delete.*db.update / cache.del.*db.update 模式）\n" +
          "2. 改用 port.doubleWrite() 委托 CachePort 处理双写顺序：\n" +
          "   await cache.doubleWrite(keyParams, async () => { await db.update(...) })\n" +
          "3. 若必须手动实现双写，确保顺序为：\n" +
          "   await db.update(...)  // 先更库\n" +
          "   await cache.delete(keyParams)  // 后删缓存\n" +
          "4. 添加并发测试覆盖双写一致性（多线程并发读写）",
      },

      // TCS-CACHE-03：缓存穿透无防护
      {
        id: "TCS-CACHE-03",
        name: "缓存穿透无防护",
        description:
          "缓存未命中时必须通过空值缓存（nullCache=true）或布隆过滤器防护穿透，禁止直接透传到 DB。" +
          "缓存穿透是指攻击者查询大量不存在的 key，缓存未命中导致所有查询透传到 DB，DB 负载激增最终崩溃。" +
          "正确做法：(1) 空值缓存——查询 DB 返回 null 时也写入缓存（短 TTL，如 60 秒）；" +
          "(2) 布隆过滤器——查询前先检查 key 是否可能存在，明确不存在则直接拒绝。",
        severity: "major",
        checkMethod:
          "静态扫描缓存查询逻辑——" +
          "(1) 检查 cache.getWithRebuild / port.getWithRebuild 调用是否启用 nullCache（空值缓存）；" +
          "(2) 或检查 MultiLevelCache 实例化时是否启用 bloomFilter（布隆过滤器）；" +
          "(3) 若直接调用 cache.get() + db.query() 无任何穿透防护则违规。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的缓存查询代码（搜索 cache.get.*db.query / cache.get.*db.find 模式）\n" +
          "2. 改用 cache.getWithRebuild() 启用穿透防护：\n" +
          "   await cache.getWithRebuild(keyParams, async () => db.query(), { ttlSeconds: 300, nullCache: true })\n" +
          "3. 或在 MultiLevelCache 实例化时启用布隆过滤器（默认已启用）：\n" +
          "   const cache = createCache(redisClient, { bloomExpectedItems: 10000 })\n" +
          "4. 对热点 key 额外启用互斥锁（mutex）防击穿：getWithRebuild 内置互斥锁",
      },

      // ==========================================================================
      // SQL 优化红线（§5.8.3）
      // ==========================================================================

      // TCS-SQL-01：全表扫描（无索引覆盖的 WHERE）
      {
        id: "TCS-SQL-01",
        name: "全表扫描（无索引覆盖的 WHERE）",
        description:
          "SQL 查询的 WHERE 子句字段必须被索引覆盖，禁止无索引覆盖的 WHERE 查询（导致全表扫描）。" +
          "全表扫描在大表（>10 万行）上会导致：(1) 查询耗时从毫秒级退化为秒级；" +
          "(2) DB CPU 与 IO 负载激增；(3) 锁定大量行影响并发写入。" +
          "正确做法：生成迁移脚本时强制调用 sqlOptimizer.reviewIndex() 评审索引覆盖情况，" +
          "对未覆盖的 WHERE 字段建议添加索引（联合索引遵循最左前缀原则）。",
        severity: "blocker",
        checkMethod:
          "索引评审——" +
          "(1) 调用 sqlOptimizer.reviewIndex(input) 评审 SQL 语句；" +
          "(2) 检查 IndexReviewResult.fullTableScanRisk 是否为 true（true 即违规）；" +
          "(3) 在测试库（数据量 >10 万行）上执行 EXPLAIN 验证 type 字段是否为 ALL（全表扫描）。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的 SQL 查询（运行 sqlOptimizer.reviewIndex 找出 fullTableScanRisk=true 的 SQL）\n" +
          "2. 根据 suggestedIndexes 建议添加索引：\n" +
          "   CREATE INDEX idx_table_col1_col2 ON table (col1, col2)\n" +
          "3. 联合索引遵循最左前缀原则——查询字段必须是索引的最左前缀子集\n" +
          "4. 在测试库执行 EXPLAIN 验证查询使用了索引（type 字段为 ref / range / const）",
      },

      // TCS-SQL-02：循环内单条查询（N+1）
      {
        id: "TCS-SQL-02",
        name: "循环内单条查询（N+1）",
        description:
          "禁止在循环内执行单条查询（N+1 模式），必须改为批量查询。" +
          "N+1 查询会导致：(1) 查询次数从 1 次退化为 N+1 次（N 为循环次数）；" +
          "(2) 网络往返次数激增（每次查询一次 RTT）；" +
          "(3) DB 连接池耗尽（高并发场景下 N+1 会快速耗尽连接池）。" +
          "正确做法：循环外批量查询所需数据（findMany + IN 子句），循环内从内存 Map 中查找。",
        severity: "major",
        checkMethod:
          "静态扫描代码——" +
          "(1) 调用 sqlOptimizer.detectNPlusOne(filePath, codeContent) 检测 N+1 模式；" +
          "(2) 检查 NPlusOneDetectionResult.detected 是否为 true（true 即违规）；" +
          "(3) 检测模式：for/forEach/while/map 循环内调用 findUnique/findOne/find/query 等单条查询方法。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的 N+1 查询（运行 sqlOptimizer.detectNPlusOne 找出 detected=true 的位置）\n" +
          "2. 将循环内单条查询改为循环外批量查询：\n" +
          "   // 违规：循环内单条查询\n" +
          "   for (const item of items) { const user = await userRepo.findOne(item.userId); ... }\n" +
          "   // 修复：循环外批量查询\n" +
          "   const userIds = items.map(item => item.userId);\n" +
          "   const users = await userRepo.findMany({ where: { id: { in: userIds } } });\n" +
          "   const userMap = new Map(users.map(u => [u.id, u]));\n" +
          "   for (const item of items) { const user = userMap.get(item.userId); ... }\n" +
          "3. 若使用 ORM，启用 include/fetch 策略一次性加载关联数据：\n" +
          "   await orderRepo.findMany({ include: { user: true } })",
      },

      // TCS-SQL-03：深分页 offset 滥用
      {
        id: "TCS-SQL-03",
        name: "深分页 offset 滥用",
        description:
          "禁止深分页（OFFSET > 10000），必须改用游标分页或 keyset 分页。" +
          "深分页会导致 DB 扫描 offset+limit 行后丢弃前 offset 行——offset 越大性能越差：\n" +
          "  OFFSET 100000 LIMIT 20 → DB 扫描 100020 行后丢弃前 100000 行（性能极差）。" +
          "正确做法：(1) 游标分页——基于上一页最后一条记录的 ID 分页（WHERE id > ?last_id）；" +
          "(2) Keyset 分页——基于上一页最后一条记录的排序键分页。",
        severity: "major",
        checkMethod:
          "静态扫描 SQL 语句的 OFFSET 参数——" +
          "(1) 调用 sqlOptimizer.checkPagination(sql) 检查分页规范；" +
          "(2) 检查 PaginationCheckResult.isDeepPagination 是否为 true（true 即违规）；" +
          "(3) 检测模式：SQL 语句中 OFFSET > 10000。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的深分页查询（运行 sqlOptimizer.checkPagination 找出 isDeepPagination=true 的 SQL）\n" +
          "2. 改用游标分页（推荐）：\n" +
          "   // 违规：深分页\n" +
          "   SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 100000;\n" +
          "   // 修复：游标分页\n" +
          "   SELECT * FROM orders WHERE id > ?last_id ORDER BY id LIMIT 20;\n" +
          "3. 或改用 Keyset 分页（多列排序时）：\n" +
          "   SELECT * FROM orders WHERE (created_at, id) > (?last_created_at, ?last_id) ORDER BY created_at, id LIMIT 20;\n" +
          "4. 导出场景使用流式查询（cursor-based stream），禁全量加载内存",
      },

      // ==========================================================================
      // LDAP / SSO 接入红线（§5.8.4）
      // ==========================================================================

      // TCS-LDAP-01：直连 LDAP 实时查询无缓存
      {
        id: "TCS-LDAP-01",
        name: "直连 LDAP 实时查询无缓存",
        description:
          "禁止每次登录直连 LDAP 实时查询用户信息，必须通过本地镜像/增量缓存。" +
          "直连 LDAP 实时查询会导致：(1) LDAP 服务器负载激增（高并发登录场景）；" +
          "(2) 登录延迟增加（每次登录一次 LDAP RTT）；" +
          "(3) LDAP 不可用时所有登录失败（无降级能力）。" +
          "正确做法：(1) 通过 LdapSyncPort.incrementalSync(username) 走增量缓存；" +
          "(2) 增量缓存命中则不查询 LDAP；" +
          "(3) 缓存未命中才查询 LDAP 并更新本地镜像。",
        severity: "major",
        checkMethod:
          "静态扫描登录流程代码——" +
          "(1) 检查登录认证是否通过 ldapSyncPort.incrementalSync / ldapSyncPort.authenticate 走缓存；" +
          "(2) 禁止业务代码直接调用 ldapClient.searchUsersByUsername 或 ldapClient.validateCredentials；" +
          "(3) LDAP 客户端应仅由 LdapSynchronizer 内部调用，业务代码通过 LdapSyncPort 接口访问。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的直连 LDAP 代码（搜索 ldapClient.searchUsersByUsername / ldapClient.validateCredentials 在业务代码中的调用）\n" +
          "2. 改为通过 LdapSyncPort 接口访问：\n" +
          "   // 违规：直连 LDAP\n" +
          "   const user = await ldapClient.searchUsersByUsername(username);\n" +
          "   const valid = await ldapClient.validateCredentials(username, password);\n" +
          "   // 修复：通过 LdapSyncPort\n" +
          "   const valid = await ldapSyncPort.authenticate(username, password);\n" +
          "3. 在 IoC 容器中注册 LdapSynchronizer（createLdapSynchronizer(config, ldapClient, mirrorStore)）\n" +
          "4. 业务代码通过依赖注入获取 LdapSyncPort",
      },

      // TCS-LDAP-02：同步任务无幂等
      {
        id: "TCS-LDAP-02",
        name: "同步任务无幂等",
        description:
          "LDAP 同步任务必须幂等——重复同步不产生重复账号，基于 entryUUID 集合做幂等校验。" +
          "无幂等保护会导致：(1) 重复执行同步任务时产生重复账号（同一 LDAP 用户在本地库出现多条记录）；" +
          "(2) 账号混乱（登录时无法确定使用哪条记录）；" +
          "(3) 审计追溯困难（同一用户多条记录难以追溯历史）。" +
          "正确做法：(1) 同步前查询本地已同步的 entryUUID 集合；" +
          "(2) 同步时按 entryUUID 幂等写入（存在则更新，不存在则创建）；" +
          "(3) 全量同步时检测本地存在但 LDAP 已删除的用户，删除本地镜像。",
        severity: "blocker",
        checkMethod:
          "静态扫描同步任务代码——" +
          "(1) 检查 fullSync / incrementalSync 是否调用 mirrorStore.upsertUserByEntryUUID（幂等写入）；" +
          "(2) 禁止直接调用 mirrorStore.createUser（无幂等检查）；" +
          "(3) 全量同步应检测并删除 LDAP 中已不存在的用户镜像。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的同步代码（搜索 mirrorStore.createUser / db.insert.*ldap_user 等无幂等的写入模式）\n" +
          "2. 改为通过 LdapSyncPort.fullSync / incrementalSync 委托 LdapSynchronizer 处理幂等：\n" +
          "   await ldapSyncPort.fullSync()  // 内部基于 entryUUID 幂等写入\n" +
          "3. UserMirrorStore 实现方必须保证 upsertUserByEntryUUID 的幂等性：\n" +
          "   - 按 entryUUID 查询本地是否已存在\n" +
          "   - 存在则更新（created=false, updated=true）\n" +
          "   - 不存在则创建（created=true, updated=false）\n" +
          "4. 全量同步应包含删除逻辑——LDAP 中已不存在的用户在本地镜像中也应删除",
      },

      // ==========================================================================
      // 漏洞扫描红线（§5.8.5）
      // ==========================================================================

      // TCS-SEC-01：高危依赖漏洞未修复即放行
      {
        id: "TCS-SEC-01",
        name: "高危依赖漏洞未修复即放行",
        description:
          "高危依赖漏洞（CVSS ≥7.0）必须修复后才能放行，禁止带高危漏洞发布生产。" +
          "高危漏洞包括：(1) RCE（远程代码执行）；(2) SQL 注入；(3) 认证绕过；" +
          "(4) 权限提升；(5) 敏感信息泄漏。" +
          "带高危漏洞发布会导致：(1) 攻击者可利用漏洞入侵系统；(2) 数据泄漏/篡改/勒索；" +
          "(3) 合规违规（如等保/GDPR 罚款）；(4) 企业声誉损失。" +
          "正确做法：CODING Loop 的 Verification 阶段调用 vulnerabilityScanner.scan() 执行依赖漏洞扫描，" +
          "verdict=fix 则进入 FIX 动作修复漏洞后重试。",
        severity: "blocker",
        checkMethod:
          "依赖漏洞扫描——" +
          "(1) 调用 vulnerabilityScanner.scan(projectPath) 执行三层扫描；" +
          "(2) 检查 VulnerabilityScanResult.highRiskCount 是否 >0（>0 即违规）；" +
          "(3) 工具：npm audit / OWASP Dependency-Check（解析 CVE 数据库）。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的高危依赖漏洞（运行 vulnerabilityScanner.scan 查看 fixWorkItems）\n" +
          "2. 根据 fixWorkItems 升级依赖到修复版本：\n" +
          "   npm install pkg@<fixedVersion>\n" +
          "3. 若无修复版本，替换为不受影响的替代包：\n" +
          "   npm uninstall vulnerable-pkg && npm install safe-alternative\n" +
          "4. 若必须保留，通过 npm overrides 替换子依赖版本：\n" +
          "   { overrides: { 'vulnerable-pkg': 'safe-version' } }\n" +
          "5. 重新运行 npm audit 验证漏洞已消除\n" +
          "6. 运行项目测试套件验证升级后的兼容性",
      },

      // TCS-SEC-02：扫描出硬编码密钥
      {
        id: "TCS-SEC-02",
        name: "扫描出硬编码密钥",
        description:
          "禁止在代码中硬编码密钥（API Key / 数据库密码 / JWT 密钥 / 加密密钥等），必须从环境变量/Secret Manager 注入。" +
          "硬编码密钥会导致：(1) 密钥泄漏到 git 仓库（即使后续删除也会留在 git 历史中）；" +
          "(2) 攻击者获取代码后即可获取密钥；(3) 密钥轮换困难（需修改代码重新发布）。" +
          "正确做法：(1) 密钥存储在 Secret Manager（如 AWS Secrets Manager / Vault）；" +
          "(2) 通过环境变量注入到应用进程；(3) 应用从 process.env 读取密钥。" +
          "本红线与 E6（密钥与配置）联动——评估器同时检查两条红线。",
        severity: "blocker",
        checkMethod:
          "密钥泄漏扫描——" +
          "(1) 调用 vulnerabilityScanner.scan(projectPath) 执行三层扫描（含 secret-leak 层）；" +
          "(2) 检查 VulnerabilityScanResult.hasHardcodedSecret 是否为 true（true 即违规）；" +
          "(3) 工具：gitleaks（内置 AWS/Azure/GCP/GitHub/Stripe 等密钥模式检测）。",
        checkType: "static",
        fixGuidance:
          "1. 定位违规的硬编码密钥（运行 vulnerabilityScanner.scan 查看 sec02Violations）\n" +
          "2. 立即撤销泄漏的密钥（在密钥管理系统/云控制台）\n" +
          "3. 重新生成新密钥，配置到环境变量/Secret Manager：\n" +
          "   # .env（不入 git）\n" +
          "   AWS_ACCESS_KEY_ID=new_key_id\n" +
          "   AWS_SECRET_ACCESS_KEY=new_secret\n" +
          "4. 应用从 process.env 读取密钥：\n" +
          "   const apiKey = process.env.AWS_ACCESS_KEY_ID!;\n" +
          "5. 删除代码中的硬编码密钥\n" +
          "6. 检查 git 历史，使用 BFG Repo-Cleaner 清理泄漏记录：\n" +
          "   bfg --replace-text passwords.txt\n" +
          "7. 通知团队成员轮换所有可能泄漏的密钥",
      },
    ] as RedlineDefinition[]
  ).map((rule) => Object.freeze(rule))
);

// ============================================================================
// 辅助查询函数
// ============================================================================

/**
 * 获取 TCS 红线总数（13）
 *
 * @returns TCS 红线总数
 */
export function getTcsRedlineCount(): number {
  return TCS_REDLINES.length;
}

/**
 * 按级别过滤 TCS 红线
 *
 * @param severity 红线级别
 * @returns 该级别的 TCS 红线列表
 */
export function getTcsRedlinesBySeverity(severity: RedlineSeverity): ReadonlyArray<RedlineDefinition> {
  return Object.freeze(TCS_REDLINES.filter((r) => r.severity === severity));
}

/**
 * 按红线 ID 查找 TCS 红线
 *
 * @param id 红线 ID
 * @returns 红线定义（未找到返回 null）
 */
export function getTcsRedlineById(id: TcsRedlineId): RedlineDefinition | null {
  for (const r of TCS_REDLINES) {
    if (r.id === id) {
      return r;
    }
  }
  return null;
}

/**
 * 按分类过滤 TCS 红线
 *
 * 分类规则：
 * - oss：TCS-OSS-01~03
 * - cache：TCS-CACHE-01~03
 * - sql：TCS-SQL-01~03
 * - ldap：TCS-LDAP-01~02
 * - security：TCS-SEC-01~02
 *
 * @param category 红线分类
 * @returns 该分类的 TCS 红线列表
 */
export function getTcsRedlinesByCategory(category: TcsRedlineCategory): ReadonlyArray<RedlineDefinition> {
  // 建立分类前缀映射（TCS-OSS- / TCS-CACHE- 等）
  const prefixMap: Readonly<Record<TcsRedlineCategory, string>> = Object.freeze({
    oss: "TCS-OSS-",
    cache: "TCS-CACHE-",
    sql: "TCS-SQL-",
    ldap: "TCS-LDAP-",
    security: "TCS-SEC-",
  });
  const prefix = prefixMap[category];
  return Object.freeze(TCS_REDLINES.filter((r) => r.id.startsWith(prefix)));
}

// ============================================================================
// 红线 ID 合法性校验
// ============================================================================

/**
 * 判断给定字符串是否为合法的 TCS 红线 ID
 *
 * @param id 待校验的字符串
 * @returns true 表示合法的 TCS 红线 ID
 */
export function isValidTcsRedlineId(id: string): id is TcsRedlineId {
  return (TCS_REDLINE_IDS as readonly string[]).includes(id);
}

/**
 * 判断给定字符串是否为合法的 TCS 红线分类
 *
 * @param category 待校验的字符串
 * @returns true 表示合法的 TCS 红线分类
 */
export function isValidTcsRedlineCategory(category: string): category is TcsRedlineCategory {
  return (TCS_REDLINE_CATEGORIES as readonly string[]).includes(category);
}

// ============================================================================
// 红线统计信息
// ============================================================================

/**
 * TCS 红线统计信息
 */
export interface TcsRedlineStats {
  /** 红线总数 */
  readonly total: number;
  /** blocker 级别红线数 */
  readonly blockerCount: number;
  /** major 级别红线数 */
  readonly majorCount: number;
  /** warning 级别红线数 */
  readonly warningCount: number;
  /** 各分类的红线数 */
  readonly byCategory: Readonly<Record<TcsRedlineCategory, number>>;
}

/**
 * 获取 TCS 红线统计信息
 *
 * @returns TCS 红线统计信息
 */
export function getTcsRedlineStats(): TcsRedlineStats {
  let blockerCount = 0;
  let majorCount = 0;
  let warningCount = 0;
  const byCategory: Record<TcsRedlineCategory, number> = {
    oss: 0,
    cache: 0,
    sql: 0,
    ldap: 0,
    security: 0,
  };

  for (const r of TCS_REDLINES) {
    if (r.severity === "blocker") blockerCount++;
    else if (r.severity === "major") majorCount++;
    else if (r.severity === "warning") warningCount++;

    // 按 ID 前缀分类
    if (r.id.startsWith("TCS-OSS-")) byCategory.oss++;
    else if (r.id.startsWith("TCS-CACHE-")) byCategory.cache++;
    else if (r.id.startsWith("TCS-SQL-")) byCategory.sql++;
    else if (r.id.startsWith("TCS-LDAP-")) byCategory.ldap++;
    else if (r.id.startsWith("TCS-SEC-")) byCategory.security++;
  }

  return Object.freeze({
    total: TCS_REDLINES.length,
    blockerCount,
    majorCount,
    warningCount,
    byCategory: Object.freeze(byCategory),
  });
}
