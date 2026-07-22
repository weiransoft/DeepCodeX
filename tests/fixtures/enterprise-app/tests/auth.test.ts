import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { signToken } from "../src/auth/jwt.js";

/**
 * Mock 响应数据类型（loginHandler / authMiddleware 的 json 载荷）
 */
interface MockResponseData {
  /** 登录成功返回的 JWT token */
  token?: string;
  /** token 有效期（秒） */
  expiresIn?: number;
  /** 错误信息 */
  error?: string;
}

/**
 * 类型化的 Mock Response（对齐 Express Response 的 status/json 链式调用契约）
 *
 * 消除每个用例重复定义 mockRes 对象 + json(data: any) 的 any 类型问题
 */
interface MockRes {
  /** 记录的 HTTP 状态码 */
  statusCode: number;
  /** 记录的响应数据 */
  responseData: MockResponseData | null;
  /** 设置状态码（链式） */
  status(code: number): MockRes;
  /** 设置响应数据（链式） */
  json(data: MockResponseData): MockRes;
}

/**
 * Mock Response 工厂（消除 7 个用例的重复定义）
 */
function createMockRes(): MockRes {
  return {
    statusCode: 200,
    responseData: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: MockResponseData) {
      this.responseData = data;
      return this;
    },
  };
}

/**
 * Mock Request 类型（loginHandler 场景：仅含 body）
 */
interface MockLoginReq {
  body: { username?: string; password?: string };
}

/**
 * Mock Request 类型（authMiddleware 场景：仅含 headers）
 */
interface MockMiddlewareReq {
  headers: { authorization?: string };
}

describe("AuthModule 测试", () => {
  describe("TC-AUTH-08: signToken 返回字符串", () => {
    it('signToken({username:"admin"}) 返回字符串，长度 > 0', () => {
      const token = signToken({ username: "admin" });
      assert.strictEqual(typeof token, "string");
      assert.ok(token.length > 0);
    });
  });

  describe("TC-AUTH-01~04: 登录处理函数测试（需要 HTTP 服务器）", () => {
    it("正确用户名密码登录返回 JWT token", async () => {
      const mockReq: MockLoginReq = {
        body: { username: "admin", password: "admin123" },
      };
      const mockRes = createMockRes();

      const { loginHandler } = await import("../src/auth/jwt.js");
      // 双重断言：测试 mock 结构不完整实现 Express Request/Response 全部契约，
      // 但 loginHandler 仅使用 body / status / json，mock 结构满足运行时需求
      loginHandler(mockReq as unknown as Request, mockRes as unknown as Response);

      assert.strictEqual(mockRes.statusCode, 200);
      assert.ok(mockRes.responseData);
      assert.ok(mockRes.responseData.token);
      assert.strictEqual(typeof mockRes.responseData.token, "string");
      assert.ok(mockRes.responseData.token.length > 0);
    });

    it("错误密码返回 401", async () => {
      const mockReq: MockLoginReq = {
        body: { username: "admin", password: "wrong" },
      };
      const mockRes = createMockRes();

      const { loginHandler } = await import("../src/auth/jwt.js");
      loginHandler(mockReq as unknown as Request, mockRes as unknown as Response);

      assert.strictEqual(mockRes.statusCode, 401);
      assert.ok(mockRes.responseData);
      assert.ok(mockRes.responseData.error);
    });

    it("错误用户名返回 401", async () => {
      const mockReq: MockLoginReq = {
        body: { username: "wrong", password: "admin123" },
      };
      const mockRes = createMockRes();

      const { loginHandler } = await import("../src/auth/jwt.js");
      loginHandler(mockReq as unknown as Request, mockRes as unknown as Response);

      assert.strictEqual(mockRes.statusCode, 401);
    });

    it("缺少用户名返回 400", async () => {
      const mockReq: MockLoginReq = {
        body: { password: "admin123" },
      };
      const mockRes = createMockRes();

      const { loginHandler } = await import("../src/auth/jwt.js");
      loginHandler(mockReq as unknown as Request, mockRes as unknown as Response);

      assert.strictEqual(mockRes.statusCode, 400);
    });
  });

  describe("TC-AUTH-05~07: authMiddleware 中间件测试", () => {
    it("无 token 访问受保护接口返回 401", async () => {
      const mockReq: MockMiddlewareReq = {
        headers: {},
      };
      const mockRes = createMockRes();
      let nextCalled = false;
      const mockNext = () => {
        nextCalled = true;
      };

      const { authMiddleware } = await import("../src/auth/jwt.js");
      authMiddleware(mockReq as unknown as Request, mockRes as unknown as Response, mockNext);

      assert.strictEqual(mockRes.statusCode, 401);
      assert.strictEqual(nextCalled, false);
    });

    it("无效 token 访问受保护接口返回 401", async () => {
      const mockReq: MockMiddlewareReq = {
        headers: { authorization: "Bearer invalid-token" },
      };
      const mockRes = createMockRes();
      let nextCalled = false;
      const mockNext = () => {
        nextCalled = true;
      };

      const { authMiddleware } = await import("../src/auth/jwt.js");
      authMiddleware(mockReq as unknown as Request, mockRes as unknown as Response, mockNext);

      assert.strictEqual(mockRes.statusCode, 401);
      assert.strictEqual(nextCalled, false);
    });

    it("有效 token 访问受保护接口通过", async () => {
      const token = signToken({ username: "admin" });
      const mockReq: MockMiddlewareReq = {
        headers: { authorization: `Bearer ${token}` },
      };
      const mockRes = createMockRes();
      let nextCalled = false;
      const mockNext = () => {
        nextCalled = true;
      };

      const { authMiddleware } = await import("../src/auth/jwt.js");
      authMiddleware(mockReq as unknown as Request, mockRes as unknown as Response, mockNext);

      assert.strictEqual(nextCalled, true);
      assert.notStrictEqual(mockRes.statusCode, 401);
    });
  });
});
