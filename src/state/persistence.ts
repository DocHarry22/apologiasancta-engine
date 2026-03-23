import { dirname, resolve } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";

export interface PersistedEnginePayload {
  content: unknown;
  topicSequence: unknown;
  controller: unknown;
  rooms: unknown;
  players: unknown;
}

interface PersistedEngineState extends PersistedEnginePayload {
  version: 1;
  savedAt: number;
}

interface PersistenceConfig {
  getSnapshot: () => PersistedEnginePayload;
  applySnapshot: (snapshot: PersistedEnginePayload) => void;
}

export interface PersistenceStatus {
  configured: boolean;
  path: string;
  savePending: boolean;
  lastSavedAt: number | null;
  lastRestoredAt: number | null;
  lastRestoreSucceeded: boolean;
}

let stateFilePathOverride: string | null = null;
const SAVE_DEBOUNCE_MS = 250;

let persistenceConfig: PersistenceConfig | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let writeChain: Promise<void> = Promise.resolve();
let isHydrating = false;
let lastSavedAt: number | null = null;
let lastRestoredAt: number | null = null;
let lastRestoreSucceeded = false;

function getResolvedStateFilePath(): string {
  if (stateFilePathOverride) {
    return stateFilePathOverride;
  }

  if (process.env.STATE_FILE_PATH) {
    return resolve(process.env.STATE_FILE_PATH);
  }

  return resolve(process.cwd(), "data", "runtime-state.json");
}

export function configureStatePersistence(config: PersistenceConfig): void {
  persistenceConfig = config;
}

export function getStatePersistencePath(): string {
  return getResolvedStateFilePath();
}

export function getPersistenceStatus(): PersistenceStatus {
  return {
    configured: persistenceConfig !== null,
    path: getResolvedStateFilePath(),
    savePending: saveTimer !== null,
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
    writeChain = writeChain
      .then(() => persistNow())
      .catch((error) => {
        console.error("[Persistence] Failed to save runtime state:", error);
      });
  }, SAVE_DEBOUNCE_MS);
}

async function persistNow(): Promise<void> {
  if (!persistenceConfig) {
    return;
  }

  const snapshot: PersistedEngineState = {
    version: 1,
    savedAt: Date.now(),
    ...persistenceConfig.getSnapshot(),
  };

  const stateFilePath = getResolvedStateFilePath();
  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, JSON.stringify(snapshot, null, 2), "utf8");
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

  writeChain = writeChain
    .then(() => persistNow())
    .catch((error) => {
      console.error("[Persistence] Failed to flush runtime state:", error);
      throw error;
    });

  await writeChain;
  return true;
}

export async function restorePersistedState(): Promise<boolean> {
  if (!persistenceConfig) {
    lastRestoreSucceeded = false;
    return false;
  }

  let raw: string;
  const stateFilePath = getResolvedStateFilePath();
  try {
    raw = await readFile(stateFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      lastRestoreSucceeded = false;
      return false;
    }

    console.error("[Persistence] Failed to read runtime state:", error);
    lastRestoreSucceeded = false;
    return false;
  }

  let parsed: PersistedEngineState;
  try {
    parsed = JSON.parse(raw) as PersistedEngineState;
  } catch (error) {
    console.error("[Persistence] Failed to parse runtime state:", error);
    lastRestoreSucceeded = false;
    return false;
  }

  if (parsed.version !== 1) {
    console.warn(`[Persistence] Unsupported runtime state version: ${String((parsed as { version?: unknown }).version)}`);
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
  console.log(`[Persistence] Restored runtime state from ${stateFilePath}`);
  return true;
}

export function setStatePersistencePathForTests(filePath: string | null): void {
  stateFilePathOverride = filePath ? resolve(filePath) : null;
}

export function resetPersistenceForTests(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  persistenceConfig = null;
  writeChain = Promise.resolve();
  isHydrating = false;
  lastSavedAt = null;
  lastRestoredAt = null;
  lastRestoreSucceeded = false;
  stateFilePathOverride = null;
}