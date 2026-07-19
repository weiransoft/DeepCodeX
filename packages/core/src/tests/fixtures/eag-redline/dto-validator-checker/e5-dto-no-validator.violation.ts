/**
 * Fixture: E5 DTO 无 class-validator 装饰器（违规样例）
 *
 * @fixtureId dto-validator-checker/e5-dto-no-validator.violation
 * @checker DtoValidatorChecker
 * @redlineIds E5
 * @kind violation
 * @expectVerdict violated
 * @description CreateUserDTO 类字段无任何 class-validator 装饰器——违反 E5 输入校验红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/interfaces/user/dto/CreateUserDTO.ts",
    content: `// src/interfaces/user/dto/CreateUserDTO.ts
/**
 * 创建用户 DTO
 */
export class CreateUserDTO {
  // 违规点：字段无任何 class-validator 装饰器
  username: string;
  email: string;
  password: string;
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
