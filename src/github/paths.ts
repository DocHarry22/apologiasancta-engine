/**
 * GitHub path helpers for content files
 *
 * Provides consistent path generation for content files in the UI repo.
 */

/**
 * Get the path to the topics index file
 */
export function topicsIndexPath(contentRoot: string): string {
  return `${contentRoot}/index.json`;
}

/**
 * Get the path to a topic's meta.json file
 */
export function topicMetaPath(contentRoot: string, topicId: string): string {
  return `${contentRoot}/${topicId}/meta.json`;
}

/**
 * Get the path to a topic's manifest.json file
 * The manifest tracks all question IDs for efficient GitHub API usage
 */
export function topicManifestPath(contentRoot: string, topicId: string): string {
  return `${contentRoot}/${topicId}/manifest.json`;
}

/**
 * Get the path to a specific question file
 */
export function topicQuestionPath(
  contentRoot: string,
  topicId: string,
  questionId: string
): string {
  return `${contentRoot}/${topicId}/questions/${questionId}.json`;
}

/**
 * Get the directory path for a topic's questions
 */
export function topicQuestionsDir(contentRoot: string, topicId: string): string {
  return `${contentRoot}/${topicId}/questions`;
}
