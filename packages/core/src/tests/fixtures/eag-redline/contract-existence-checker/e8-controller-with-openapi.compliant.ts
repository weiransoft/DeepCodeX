/**
 * Fixture: E8 Controller 含 OpenAPI 装饰器（合规样例）
 *
 * @fixtureId contract-existence-checker/e8-controller-with-openapi.compliant
 * @checker ContractExistenceChecker
 * @redlineIds E8
 * @kind compliant
 * @expectVerdict passed
 * @description UserController 含 @ApiTags + @ApiOperation + @ApiResponse 装饰器——符合 E8 API 契约红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/interfaces/user/controllers/UserController.ts",
    content: `// src/interfaces/user/controllers/UserController.ts
import { Controller, Get, Post, Body, Param } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiProperty } from "@nestjs/swagger";

/**
 * 用户控制器——合规点：含 OpenAPI 装饰器
 */
@ApiTags("users")
@Controller("users")
export class UserController {
  /**
   * 创建用户
   */
  @ApiOperation({ summary: "创建用户", description: "创建新用户账号" })
  @ApiResponse({ status: 201, description: "用户创建成功", type: UserResponse })
  @ApiResponse({ status: 400, description: "输入参数错误" })
  @Post()
  async createUser(@Body() createUserDto: CreateUserDto): Promise<UserResponse> {
    return this.userService.create(createUserDto);
  }

  /**
   * 获取用户详情
   */
  @ApiOperation({ summary: "获取用户详情", description: "根据用户 ID 查询用户信息" })
  @ApiResponse({ status: 200, description: "查询成功", type: UserResponse })
  @ApiResponse({ status: 404, description: "用户不存在" })
  @Get(":id")
  async getUser(@Param("id") id: string): Promise<UserResponse> {
    return this.userService.findById(id);
  }
}

class CreateUserDto {
  @ApiProperty({ description: "用户名", example: "zhangsan" })
  username: string;

  @ApiProperty({ description: "邮箱", example: "zhangsan@example.com" })
  email: string;
}

class UserResponse {
  @ApiProperty({ description: "用户 ID" })
  id: string;

  @ApiProperty({ description: "用户名" })
  username: string;

  @ApiProperty({ description: "邮箱" })
  email: string;
}
`,
  },
]);
