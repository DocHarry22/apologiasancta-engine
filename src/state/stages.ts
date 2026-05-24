import { getActiveTopicId, getAllTopicIds, topicIdToTitle } from "../content/bank";
import type { StageSummary } from "../types/quiz";

const completedStagesByRoom = new Map<string, Set<string>>();

function getCompletedStages(roomId: string): Set<string> {
  let completed = completedStagesByRoom.get(roomId);
  if (!completed) {
    completed = new Set<string>();
    completedStagesByRoom.set(roomId, completed);
  }
  return completed;
}

export function markStageCompleted(roomId: string, stageId: string): void {
  getCompletedStages(roomId).add(stageId);
}

export function listStagesForRoom(roomId: string): StageSummary[] {
  const activeTopicId = getActiveTopicId(roomId);
  const completed = getCompletedStages(roomId);

  return getAllTopicIds().sort().map((topicId) => {
    const stageId = topicId;
    const isActive = activeTopicId === topicId;
    return {
      stageId,
      stageTitle: topicIdToTitle(topicId),
      topicId,
      topicTitle: topicIdToTitle(topicId),
      status: isActive ? "active" : completed.has(stageId) ? "completed" : "available",
    };
  });
}

export function resetStagesForTests(): void {
  completedStagesByRoom.clear();
}
