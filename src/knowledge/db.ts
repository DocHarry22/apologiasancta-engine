import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_VERSION } from "./schema";

let pool: Pool | null = null;
let ready = false;
let lastError: string | null = null;
let schemaVersion: number | null = null;

export function getKnowledgeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.KNOWLEDGE_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || null;
}

export function isKnowledgeEngineRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KNOWLEDGE_ENGINE_REQUIRED?.trim().toLowerCase() === "true";
}

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = getKnowledgeDatabaseUrl();
  if (!connectionString) throw new Error("Knowledge Engine database is not configured");
  pool = new Pool({
    connectionString,
    max: Number.parseInt(process.env.KNOWLEDGE_DB_POOL_MAX ?? "6", 10) || 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "apologiasancta-knowledge-engine",
  });
  pool.on("error", (error) => {
    lastError = error.message;
    console.error("[KnowledgeDB] idle client error", error);
  });
  return pool;
}

export async function ensureKnowledgeSchema(): Promise<void> {
  if (!getKnowledgeDatabaseUrl()) {
    ready = false;
    if (isKnowledgeEngineRequired()) throw new Error("KNOWLEDGE_ENGINE_REQUIRED=true but no DATABASE_URL is configured");
    return;
  }
  try {
    const db = getPool();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(KNOWLEDGE_SCHEMA_SQL);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const result = await db.query<{ schema_version: number }>(
      "SELECT schema_version FROM knowledge_schema_meta WHERE singleton = 1"
    );
    schemaVersion = result.rows[0]?.schema_version ?? KNOWLEDGE_SCHEMA_VERSION;
    ready = true;
    lastError = null;
  } catch (error) {
    ready = false;
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export async function queryKnowledge<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  if (!ready) await ensureKnowledgeSchema();
  if (!ready) throw new Error("Knowledge Engine database is unavailable");
  const result = await getPool().query<T>(text, values);
  return result.rows;
}

export async function withKnowledgeTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!ready) await ensureKnowledgeSchema();
  if (!ready) throw new Error("Knowledge Engine database is unavailable");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function getKnowledgeEngineStatus() {
  return {
    configured: Boolean(getKnowledgeDatabaseUrl()),
    required: isKnowledgeEngineRequired(),
    ready,
    schemaVersion,
    expectedSchemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    lastError,
  };
}

export async function closeKnowledgeDatabase(): Promise<void> {
  const current = pool;
  pool = null;
  ready = false;
  schemaVersion = null;
  if (current) await current.end();
}
