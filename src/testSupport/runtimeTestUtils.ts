import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { clearBank, getContentBankPersistenceSnapshot, hydrateContentBankPersistenceSnapshot } from "../content/bank";
import { getTopicSequencePersistenceSnapshot, hydrateTopicSequencePersistenceSnapshot } from "../config/topicSequence";
import { getControllerPersistenceSnapshot, hydrateControllerPersistenceSnapshot } from "../engine/roundController";
import { createApp } from "../app";
import { getPlayersPersistenceSnapshot, hydratePlayersPersistenceSnapshot, resetAllPlayers } from "../state/players";
import {
  configureStatePersistence,
  flushPersistence,
  type PersistenceDriver,
  resetPersistenceForTests,
  restorePersistedState,
  setStatePersistenceDbPathForTests,
  setStatePersistenceDriverForTests,
  setStatePersistencePathForTests,
} from "../state/persistence";
import { getRoomsPersistenceSnapshot, hydrateRoomsPersistenceSnapshot } from "../state/rooms";
import { resetBrokerForTests } from "../sse/broker";
import { resetIdentityExchangeForTests } from "../routes/identity";

async function removeDirWithRetries(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY") {
        throw error;
      }

      if (attempt === 4) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function withPatchedNow<T>(nowMs: number, callback: () => Promise<T> | T): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
}

export function resetRuntimeState(): void {
  resetBrokerForTests();
  resetIdentityExchangeForTests();
  clearBank();
  resetAllPlayers();
  hydrateTopicSequencePersistenceSnapshot(null);
  hydrateRoomsPersistenceSnapshot(null);
  hydratePlayersPersistenceSnapshot(null);
  hydrateControllerPersistenceSnapshot(null);
}

async function createTempPersistencePath(fileName: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "apologia-sancta-engine-tests-"));
  return {
    filePath: join(dir, fileName),
    cleanup: async () => {
      await removeDirWithRetries(dir);
    },
  };
}

export async function createTempStateFilePath(): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  return createTempPersistencePath("runtime-state.json");
}

export async function createTempStateDbPath(): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  return createTempPersistencePath("runtime-state.sqlite");
}

export function configurePersistenceForTests(filePath: string, driver: PersistenceDriver = "file"): void {
  setStatePersistenceDriverForTests(driver);
  setStatePersistencePathForTests(driver === "file" ? filePath : null);
  setStatePersistenceDbPathForTests(driver === "sqlite" ? filePath : null);
  configureStatePersistence({
    getSnapshot: () => ({
      content: getContentBankPersistenceSnapshot(),
      topicSequence: getTopicSequencePersistenceSnapshot(),
      controller: getControllerPersistenceSnapshot(),
      rooms: getRoomsPersistenceSnapshot(),
      players: getPlayersPersistenceSnapshot(),
    }),
    applySnapshot: (snapshot) => {
      hydrateContentBankPersistenceSnapshot(snapshot.content as ReturnType<typeof getContentBankPersistenceSnapshot>);
      hydrateTopicSequencePersistenceSnapshot(snapshot.topicSequence as ReturnType<typeof getTopicSequencePersistenceSnapshot>);
      hydrateRoomsPersistenceSnapshot(snapshot.rooms as ReturnType<typeof getRoomsPersistenceSnapshot>);
      hydratePlayersPersistenceSnapshot(snapshot.players as ReturnType<typeof getPlayersPersistenceSnapshot>);
      hydrateControllerPersistenceSnapshot(snapshot.controller as ReturnType<typeof getControllerPersistenceSnapshot>);
    },
  });
}

export async function resetPersistenceState(): Promise<void> {
  try {
    await flushPersistence();
  } catch {
    // Ignore flush failures during test cleanup.
  }
  await resetPersistenceForTests();
}

export async function restoreConfiguredPersistence(): Promise<boolean> {
  return restorePersistedState();
}

export async function startTestServer() {
  const previousAdminToken = process.env.ADMIN_TOKEN;
  if (!previousAdminToken) {
    process.env.ADMIN_TOKEN = "dev-admin-token";
  }
  const app = createApp();
  const server = await new Promise<import("http").Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine test server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = previousAdminToken;
    },
  };
}
