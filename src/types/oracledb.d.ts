declare module "oracledb" {
  export interface Pool {
    getConnection(): Promise<Connection>;
    close(): Promise<void>;
  }
  export interface Connection {
    execute(sql: string, binds?: any[], options?: any): Promise<Result>;
    close(): Promise<void>;
  }
  export interface Result {
    rows?: any[][];
    metaData?: { name: string }[];
    rowsAffected?: number;
  }
  export function createPool(config: any): Promise<Pool>;
  const _default: { createPool: typeof createPool; Pool: any; Connection: any };
  export default _default;
}