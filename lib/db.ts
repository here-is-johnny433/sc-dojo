import { Pool } from "pg";

declare global {
  var _dojoPool: Pool | undefined;
  var _dojoPoolRO: Pool | undefined;
}

export function db(): Pool {
  if (!global._dojoPool) {
    global._dojoPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return global._dojoPool;
}

// Read-only role — the only pool the chat agent's query_db tool may touch.
export function dbRO(): Pool {
  if (!global._dojoPoolRO) {
    global._dojoPoolRO = new Pool({ connectionString: process.env.DATABASE_URL_RO, max: 5 });
  }
  return global._dojoPoolRO;
}
