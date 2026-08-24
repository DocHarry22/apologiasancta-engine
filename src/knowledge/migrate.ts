import "dotenv/config";
import { closeKnowledgeDatabase, ensureKnowledgeSchema, getKnowledgeEngineStatus } from "./db";

async function main() {
  await ensureKnowledgeSchema();
  const status = getKnowledgeEngineStatus();
  if (!status.ready && status.required) {
    throw new Error(status.lastError || "Knowledge Engine migration failed");
  }
  console.log(`[KnowledgeDB] schema ready=${status.ready} version=${status.schemaVersion ?? "n/a"}`);
  await closeKnowledgeDatabase();
}

void main().catch(async (error) => {
  console.error("[KnowledgeDB] migration failed", error);
  await closeKnowledgeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
