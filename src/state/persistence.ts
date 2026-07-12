import { dirname, resolve } from "path";
import { access, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

export interface PersistedEnginePayload {
  content: unknown;
  topicSequence: unknown;
  controller: unknown;
  rooms: unknown;
  players: unknown;
}

export type PersistenceDriver = "file" | "sqlite" | "postgres";

interface PostgresPoolLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
}

type PostgresPoolFactory = (connectionString: string) => Promise<PostgresPoolLike>;

interface PersistedEngineState extends PersistedEnginePayload {
  version: 1;
  savedAt: number;
}

interface PersistenceConfig {
  getSnapshot: () => PersistedEnginePayload;
  applySnapshot: (snapshot: PersistedEnginePayload) => void;
}

export interface PersistenceStatus {
  driver: PersistenceDriver;
  configured: boolean;
  path: string;
  savePending: boolean;
  lastSavedAt: number | null;
  lastRestoredAt: number | null;
  lastRestoreSucceeded: boolean;
}

let stateFilePathOverride: string | null = null;
let stateDbPathOverride: string | null = null;
let databaseUrlOverride: string | null = null;
let persistenceDriverOverride: PersistenceDriver | null = null;
const SAVE_DEBOUNCE_MS = 250;
const SQLITE_TABLE_NAME = "runtime_state_snapshots";

let persistenceConfig: PersistenceConfig | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let writeChain: Promise<void> = Promise.resolve();
let writesInFlight = 0;
let isHydrating = false;
let lastSavedAt: number | null = null;
let lastRestoredAt: number | null = null;
let lastRestoreSucceeded = false;
let sqliteDatabase: DatabaseSyncType | null = null;
let sqliteDatabasePath: string | null = null;
let postgresPool: PostgresPoolLike | null = null;
let postgresSchemaReady = false;
let postgresPoolFactoryOverride: PostgresPoolFactory | null = null;

function parsePersistenceDriver(raw: string | undefined): PersistenceDriver | null {
  if (raw === "file" || raw === "sqlite" || raw === "postgres") {
    return raw;
  }

  return null;
}

function getResolvedPersistenceDriver(): PersistenceDriver {
  if (persistenceDriverOverride) {
    return persistenceDriverOverride;
  }

  // Render can retain legacy Blueprint values on an existing service. A managed
  // database must take precedence in production so an old SQLite setting cannot
  // silently move durable state back onto the ephemeral deploy filesystem.
  if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
    return "postgres";
  }

  const configuredDriver = parsePersistenceDriver(process.env.STATE_PERSISTENCE_DRIVER);
  if (configuredDriver) {
    return configuredDriver;
  }

  if (process.env.DATABASE_URL) {
    return "postgres";
  }

  if (process.env.STATE_DB_PATH) {
    return "sqlite";
  }

  return "file";
}

function getResolvedPersistencePath(driver = getResolvedPersistenceDriver()): string {
  if (driver === "postgres") {
    return "postgresql:runtime_state_snapshots";
  }

  if (driver === "sqlite") {
    if (stateDbPathOverride) {
      return stateDbPathOverride;
    }

    if (process.env.STATE_DB_PATH) {
      return resolve(process.env.STATE_DB_PATH);
    }

    return resolve(process.cwd(), "data", "runtime-state.sqlite");
  }

  if (stateFilePathOverride) {
    return stateFilePathOverride;
  }

  if (process.env.STATE_FILE_PATH) {
    return resolve(process.env.STATE_FILE_PATH);
  }

  return resolve(process.cwd(), "data", "runtime-state.json");
}

function getResolvedDatabaseUrl(): string | null {
  return databaseUrlOverride ?? process.env.DATABASE_URL ?? null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function closeSqliteDatabase(): void {
  if (!sqliteDatabase) {
    return;
  }

  sqliteDatabase.close();
  sqliteDatabase = null;
  sqliteDatabasePath = null;
}

async function getSqliteDatabase(filePath: string): Promise<DatabaseSyncType> {
  if (sqliteDatabase && sqliteDatabasePath === filePath) {
    return sqliteDatabase;
  }

  closeSqliteDatabase();
  await mkdir(dirname(filePath), { recursive: true });

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(filePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAME} (
      slot INTEGER PRIMARY KEY CHECK (slot = 1),
      version INTEGER NOT NULL,
      saved_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);

  sqliteDatabase = database;
  sqliteDatabasePath = filePath;
  return database;
}

async function closePostgresPool(): Promise<void> {
  const pool = postgresPool;
  postgresPool = null;
  postgresSchemaReady = false;
  if (pool) {
    await pool.end();
  }
}

async function getPostgresPool(): Promise<PostgresPoolLike> {
  if (postgresPool) {
    return postgresPool;
  }

  const connectionString = getResolvedDatabaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required when STATE_PERSISTENCE_DRIVER=postgres");
  }

  if (postgresPoolFactoryOverride) {
    postgresPool = await postgresPoolFactoryOverride(connectionString);
  } else {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      application_name: "apologiasancta-engine",
    });
    postgresPool = {
      query: async (text, values) => {
        const result = await pool.query(text, values);
        return { rows: result.rows as Array<Record<string, unknown>> };
      },
      end: () => pool.end(),
    };
  }

  return postgresPool;
}

async function ensurePostgresSchema(pool: PostgresPoolLike): Promise<void> {
  if (postgresSchemaReady) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS runtime_state_snapshots (
      slot SMALLINT PRIMARY KEY CHECK (slot = 1),
      version INTEGER NOT NULL,
      saved_at BIGINT NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  postgresSchemaReady = true;
}

export function configureStatePersistence(config: PersistenceConfig): void {
  persistenceConfig = config;
}

export function getStatePersistencePath(): string {
  return getResolvedPersistencePath();
}

export function getPersistenceStatus(): PersistenceStatus {
  const driver = getResolvedPersistenceDriver();
  return {
    driver,
    configured: persistenceConfig !== null,
    path: getResolvedPersistencePath(driver),
    savePending: saveTimer !== null || writesInFlight > 0,
    lastSavedAt,
    lastRestoredAt,
    lastRestoreSucceeded,
  };
}

export function schedulePersistence(): void {
  if (!persistenceConfig || isHydrating) {
    return;
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    void enqueuePersistenceWrite().catch((error) => {
      console.error("[Persistence] Failed to save runtime state:", error);
    });
  }, SAVE_DEBOUNCE_MS);
}

function enqueuePersistenceWrite(config = persistenceConfig): Promise<void> {
  writesInFlight += 1;
  const operation = writeChain.then(() => persistNow(config));

  // Keep the shared queue usable after a failed operation. Callers still receive
  // the original rejection and can report or retry it.
  writeChain = operation.catch(() => undefined);
  void operation.finally(() => {
    writesInFlight -= 1;
  }).catch(() => undefined);
  return operation;
}

async function persistNow(config = persistenceConfig): Promise<void> {
  if (!config) {
    return;
  }

  const driver = getResolvedPersistenceDriver();
  const snapshot: PersistedEngineState = {
    version: 1,
    savedAt: Date.now(),
    ...config.getSnapshot(),
  };

  const persistencePath = getResolvedPersistencePath(driver);

  if (driver === "postgres") {
    const pool = await getPostgresPool();
    await ensurePostgresSchema(pool);
    await pool.query(
      `
        INSERT INTO runtime_state_snapshots (slot, version, saved_at, payload, updated_at)
        VALUES (1, $1, $2, $3::jsonb, NOW())
        ON CONFLICT(slot) DO UPDATE SET
          version = EXCLUDED.version,
          saved_at = EXCLUDED.saved_at,
          payload = EXCLUDED.payload,
          updated_at = NOW()
      `,
      [snapshot.version, snapshot.savedAt, JSON.stringify(snapshot)]
    );
  } else if (driver === "sqlite") {
    const database = await getSqliteDatabase(persistencePath);
    database
      .prepare(
        `
          INSERT INTO ${SQLITE_TABLE_NAME} (slot, version, saved_at, payload_json)
          VALUES (1, @version, @savedAt, @payloadJson)
          ON CONFLICT(slot) DO UPDATE SET
            version = excluded.version,
            saved_at = excluded.saved_at,
            payload_json = excluded.payload_json
        `
      )
      .run({
        version: snapshot.version,
        savedAt: snapshot.savedAt,
        payloadJson: JSON.stringify(snapshot),
      });
  } else {
    await mkdir(dirname(persistencePath), { recursive: true });
    const temporaryPath = `${persistencePath}.${process.pid}.${snapshot.savedAt}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(temporaryPath, persistencePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  lastSavedAt = snapshot.savedAt;
}

export async function flushPersistence(): Promise<boolean> {
  if (!persistenceConfig) {
    return false;
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  try {
    await enqueuePersistenceWrite();
  } catch (error) {
    console.error("[Persistence] Failed to flush runtime state:", error);
    throw error;
  }
  return true;
}

export async function shutdownPersistence(options: { flush?: boolean } = {}): Promise<boolean> {
  const finalConfig = persistenceConfig;
  const configured = finalConfig !== null;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  // Disable new writes immediately, while retaining the current configuration
  // for one final snapshot queued behind any write already in progress.
  persistenceConfig = null;
  if (finalConfig && options.flush !== false) {
    try {
      await enqueuePersistenceWrite(finalConfig);
    } catch (error) {
      console.error("[Persistence] Failed to flush runtime state:", error);
      throw error;
    }
  }

  // Close the database only after no operation can still be using it.
  await writeChain;
  closeSqliteDatabase();
  await closePostgresPool();
  return configured;
}

export async function restorePersistedState(): Promise<boolean> {
  if (!persistenceConfig) {
    lastRestoreSucceeded = false;
    return false;
  }

  const driver = getResolvedPersistenceDriver();
  const persistencePath = getResolvedPersistencePath(driver);
  let persistedValue: unknown;

  if (driver === "postgres") {
    try {
      const pool = await getPostgresPool();
      await ensurePostgresSchema(pool);
      const row = (await pool.query("SELECT payload FROM runtime_state_snapshots WHERE slot = 1")).rows[0];
      if (!row) {
        lastRestoreSucceeded = false;
        return false;
      }
      persistedValue = row.payload;
    } catch (error) {
      console.error("[Persistence] Failed to read runtime state database:", error);
      lastRestoreSucceeded = false;
      return false;
    }
  } else if (driver === "sqlite") {
    if (!(await pathExists(persistencePath))) {
      lastRestoreSucceeded = false;
      return false;
    }

    try {
      const database = await getSqliteDatabase(persistencePath);
      const row = database
        .prepare(`SELECT payload_json FROM ${SQLITE_TABLE_NAME} WHERE slot = 1`)
        .get() as { payload_json: string } | undefined;

      if (!row) {
        lastRestoreSucceeded = false;
        return false;
      }

      persistedValue = row.payload_json;
    } catch (error) {
      console.error("[Persistence] Failed to read runtime state database:", error);
      lastRestoreSucceeded = false;
      return false;
    }
  } else {
    try {
      persistedValue = await readFile(persistencePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lastRestoreSucceeded = false;
        return false;
      }

      console.error("[Persistence] Failed to read runtime state:", error);
      lastRestoreSucceeded = false;
      return false;
    }
  }

  let parsed: PersistedEngineState;
  try {
    parsed = (typeof persistedValue === "string" ? JSON.parse(persistedValue) : persistedValue) as PersistedEngineState;
  } catch (error) {
    console.error("[Persistence] Failed to parse runtime state:", error);
    lastRestoreSucceeded = false;
    return false;
  }

  if (!parsed || typeof parsed !== "object") {
    console.error("[Persistence] Runtime state payload is not an object");
    lastRestoreSucceeded = false;
    return false;
  }

  if (parsed.version !== 1) {
    console.warn(`[Persistence] Unsupported runtime state version: ${String((parsed as { version?: unknown }).version)}`);
    lastRestoreSucceeded = false;
    return false;
  }

  if (!Number.isFinite(parsed.savedAt)) {
    console.error("[Persistence] Runtime state has an invalid savedAt value");
    lastRestoreSucceeded = false;
    return false;
  }

  const requiredSections: Array<keyof PersistedEnginePayload> = ["content", "topicSequence", "controller", "rooms", "players"];
  if (requiredSections.some((section) => !(section in parsed))) {
    console.error("[Persistence] Runtime state is missing one or more required sections");
    lastRestoreSucceeded = false;
    return false;
  }

  isHydrating = true;
  try {
    persistenceConfig.applySnapshot({
      content: parsed.content,
      topicSequence: parsed.topicSequence,
      controller: parsed.controller,
      rooms: parsed.rooms,
      players: parsed.players,
    });
  } finally {
    isHydrating = false;
  }

  lastRestoredAt = Date.now();
  lastRestoreSucceeded = true;
  lastSavedAt = parsed.savedAt;
  console.log(`[Persistence] Restored runtime state from ${persistencePath}`);
  return true;
}

export function setStatePersistencePathForTests(filePath: string | null): void {
  stateFilePathOverride = filePath ? resolve(filePath) : null;
}

export function setStatePersistenceDbPathForTests(filePath: string | null): void {
  stateDbPathOverride = filePath ? resolve(filePath) : null;
}

export function setStatePersistenceDatabaseUrlForTests(connectionString: string | null): void {
  databaseUrlOverride = connectionString;
}

export function setPostgresPoolFactoryForTests(factory: PostgresPoolFactory | null): void {
  postgresPoolFactoryOverride = factory;
}

export function setStatePersistenceDriverForTests(driver: PersistenceDriver | null): void {
  persistenceDriverOverride = driver;
}

export async function resetPersistenceForTests(): Promise<void> {
  await shutdownPersistence({ flush: false });
  writeChain = Promise.resolve();
  writesInFlight = 0;
  isHydrating = false;
  lastSavedAt = null;
  lastRestoredAt = null;
  lastRestoreSucceeded = false;
  stateFilePathOverride = null;
  stateDbPathOverride = null;
  databaseUrlOverride = null;
  persistenceDriverOverride = null;
  postgresPoolFactoryOverride = null;
}
