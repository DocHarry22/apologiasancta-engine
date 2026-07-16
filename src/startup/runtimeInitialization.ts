import type { GitHubSyncResult } from "../content/github";

export interface RuntimeInitializationDependencies {
  holdRuntimeStarts(): void;
  releaseRuntimeStarts(): void;
  restorePersistedState(): Promise<boolean>;
  hasGitHubSyncConfig(): boolean;
  syncFromGitHub(): Promise<GitHubSyncResult>;
  startAutomaticQuizRuntime(): string[];
}

export interface RuntimeInitializationResult {
  restored: boolean;
  syncAttempted: boolean;
  syncResult: GitHubSyncResult | null;
  automaticRooms: string[];
}

const failedSyncResult = (error: unknown): GitHubSyncResult => ({
  success: false,
  topicsLoaded: 0,
  questionsLoaded: 0,
  errors: [error instanceof Error ? error.message : String(error)],
});

/**
 * Restore and refresh all content before permitting an OPEN answer window.
 * A sync failure is safe because the sync implementation retains the restored
 * catalog; automatic controllers are released and started exactly once after
 * either a successful sync or that safe failure.
 */
export async function initializeQuizRuntime(
  dependencies: RuntimeInitializationDependencies
): Promise<RuntimeInitializationResult> {
  dependencies.holdRuntimeStarts();
  const restored = await dependencies.restorePersistedState();
  const syncAttempted = dependencies.hasGitHubSyncConfig();
  let syncResult: GitHubSyncResult | null = null;

  if (syncAttempted) {
    try {
      syncResult = await dependencies.syncFromGitHub();
    } catch (error) {
      syncResult = failedSyncResult(error);
    }
  }

  dependencies.releaseRuntimeStarts();
  const automaticRooms = dependencies.startAutomaticQuizRuntime();
  return { restored, syncAttempted, syncResult, automaticRooms };
}
