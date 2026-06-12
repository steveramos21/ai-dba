import { Pool } from "mysql2";
import { BlockingChain } from "../types";

export async function getBlockingChainsMySQL(config: any): Promise<BlockingChain[]> {
  // TODO: Implement MySQL blocking chains query using performance_schema
  // For now, return empty array
  console.log(`[MySQL] Querying blocking chains for ${config.host}:${config.port}/${config.database}`);
  return [];
}
