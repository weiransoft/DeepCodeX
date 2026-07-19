/**
 * Fixture: 棕地契约兼容（合规样例）
 *
 * @fixtureId contract-guard-checker/brownfield-api-compatible.compliant
 * @checker ContractGuardChecker
 * @redlineIds BROWNFIELD-CONTRACT
 * @kind compliant
 * @expectVerdict passed
 * @description 新增可选参数 cancelOrder(orderId, reason?: string)——向后兼容，符合棕地契约保护红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/order/OrderService.ts",
    content: `// src/application/order/OrderService.ts
/**
 * 订单应用服务——合规点：新增可选参数，向后兼容
 */
export class OrderService {
  /**
   * 取消订单——合规点：新增可选参数，向后兼容
   */
  async cancelOrder(orderId: string, reason?: string): Promise<void> {
    // 合规点：既有签名为 cancelOrder(orderId: string, reason: string)，现改为 cancelOrder(orderId: string, reason?: string)
    // 新增可选参数保持向后兼容，调用方可选择传递或不传递取消原因
    console.log(\`Cancelling order \${orderId}, reason: \${reason ?? "N/A"}\`);
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
