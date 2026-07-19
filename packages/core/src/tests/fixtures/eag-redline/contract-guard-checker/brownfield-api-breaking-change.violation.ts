/**
 * Fixture: 棕地契约破坏（违规样例）
 *
 * @fixtureId contract-guard-checker/brownfield-api-breaking-change.violation
 * @checker ContractGuardChecker
 * @redlineIds BROWNFIELD-CONTRACT
 * @kind violation
 * @expectVerdict violated
 * @description 修改既有 cancelOrder(orderId, reason) 为 cancelOrder(orderId)——参数减少，破坏向后兼容
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/order/OrderService.ts",
    content: `// src/application/order/OrderService.ts
/**
 * 订单应用服务——违规点：破坏既有 API 契约（参数减少）
 */
export class OrderService {
  /**
   * 取消订单——违规点：参数从 2 个减少到 1 个，破坏向后兼容
   */
  async cancelOrder(orderId: string): Promise<void> {
    // 违规点：既有签名为 cancelOrder(orderId: string, reason: string)，现改为 cancelOrder(orderId: string)
    // 参数减少导致调用方无法传递取消原因，破坏向后兼容
    console.log(\`Cancelling order \${orderId}\`);
  }
}
`,
  },
]);

/**
 * 棕地既有契约 baseline
 *
 * 测试时通过 createContractGuardChecker(BROWNFIELD_BASELINE) 注入。
 */
export const BROWNFIELD_BASELINE: ReadonlyArray<{ readonly apiName: string; readonly signature: string }> =
  Object.freeze([
    {
      apiName: "cancelOrder",
      signature: "cancelOrder(orderId: string, reason: string)",
    },
  ]);
