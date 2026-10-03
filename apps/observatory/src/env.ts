export interface Env {
  SNAPSHOTS: KVNamespace;
  DB: D1Database;
  EXPORTS: R2Bucket;
  BASE_RPC_URL: string;
}
