/**
 * Fixture: E5 DTO 含 class-validator 装饰器（合规样例）
 *
 * @fixtureId dto-validator-checker/e5-dto-with-validator.compliant
 * @checker DtoValidatorChecker
 * @redlineIds E5
 * @kind compliant
 * @expectVerdict passed
 * @description CreateUserDTO 字段含 @IsString / @IsEmail / @MinLength 等装饰器——符合 E5 输入校验红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/interfaces/user/dto/CreateUserDTO.ts",
    content: `// src/interfaces/user/dto/CreateUserDTO.ts
import { IsString, IsEmail, MinLength, IsInt, Min, Max } from "class-validator";

/**
 * 创建用户 DTO
 */
export class CreateUserDTO {
  // 合规点：字段含 class-validator 装饰器
  @IsString()
  @MinLength(3)
  username: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsInt()
  @Min(0)
  @Max(150)
  age: number;

  constructor(username: string, email: string, password: string, age: number) {
    this.username = username;
    this.email = email;
    this.password = password;
    this.age = age;
  }
}
`,
  },
]);
