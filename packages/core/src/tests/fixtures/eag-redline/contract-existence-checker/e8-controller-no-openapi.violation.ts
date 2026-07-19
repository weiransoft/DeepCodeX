/**
 * Fixture: E8 Controller 无 OpenAPI 装饰器（违规样例）
 *
 * @fixtureId contract-existence-checker/e8-controller-no-openapi.violation
 * @checker ContractExistenceChecker
 * @redlineIds E8
 * @kind violation
 * @expectVerdict violated
 * @description UserController 无 @ApiTags/@ApiOperation 装饰器，且无 openapi.yaml——违反 E8 API 契约红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/interfaces/user/controllers/UserController.ts",
    content: `// src/interfaces/user/controllers/UserController.ts
import { Controller, Get, Post, Body, Param } from "@nestjs/common";

/**
 * 用户控制器——违规点：无 OpenAPI 装饰器
 */
@Controller("users")
export class UserController {
  /**
   * 创建用户
   */
  @Post()
  async createUser(@Body() createUserDto: CreateUserDto): Promise<UserResponse> {
    return this.userService.create(createUserDto);
  }

  /**
   * 获取用户详情
   */
  @Get(":id")
  async getUser(@Param("id") id: string): Promise<UserResponse> {
    return this.userService.findById(id);
  }
}

interface CreateUserDto {
  username: string;
  email: string;
}

interface UserResponse {
  id: string;
  username: string;
  email: string;
}
`,
  },
]);
