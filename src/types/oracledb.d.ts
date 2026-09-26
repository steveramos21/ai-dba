declare module "oracledb" {
  export interface Pool {
    getConnection(): Promise<Connection>;
    close(): Promise<void>;
  }
  export interface Connection {
    execute(sql: string, binds?: any[], options?: any): Promise<Result>;
    /** Closes the connection. `{ drop: true }` drops the session instead of returning it to the pool. */
    close(options?: { drop?: boolean }): Promise<void>;
    /** Round-trip timeout in ms (0 = disabled). Set per query on pooled connections. */
    callTimeout: number;
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