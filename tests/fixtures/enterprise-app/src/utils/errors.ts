/**
 * 业务错误类定义
 * 用于统一错误处理和 HTTP 状态码映射
 */

/** 资源未找到错误 (404) */
export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** 参数校验错误 (400) */
export class ValidationError extends Error {
  constructor(field: string, reason: string) {
    super(`Validation failed for ${field}: ${reason}`);
    this.name = "ValidationError";
  }
}

/** 库存不足错误 (400) */
export class InsufficientStockError extends Error {
  constructor(productId: string, requested: number, available: number) {
    super(`Insufficient stock for product ${productId}: requested ${requested}, available ${available}`);
    this.name = "InsufficientStockError";
  }
}

/** 认证失败错误 (401) */
export class AuthenticationError extends Error {
  constructor(reason: string) {
    super(`Authentication failed: ${reason}`);
    this.name = "AuthenticationError";
  }
}
