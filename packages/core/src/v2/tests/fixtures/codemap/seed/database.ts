/**
 * CodeMap 性能基准测试种子文件 - 数据库连接
 */

export class DatabaseConnection {
  constructor(private connectionString: string) {}

  async connect(): Promise<void> {
    console.log(`Connecting to: ${this.connectionString}`);
  }

  async disconnect(): Promise<void> {
    console.log("Disconnected");
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    console.log(`Query: ${sql}, Params: ${JSON.stringify(params)}`);
    return [];
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    console.log(`Execute: ${sql}, Params: ${JSON.stringify(params)}`);
    return 1;
  }
}

export class Transaction {
  private operations: (() => Promise<unknown>)[] = [];

  constructor(private db: DatabaseConnection) {}

  add(operation: () => Promise<unknown>): void {
    this.operations.push(operation);
  }

  async commit(): Promise<void> {
    for (const op of this.operations) {
      await op();
    }
    this.operations = [];
  }

  rollback(): void {
    this.operations = [];
  }
}
