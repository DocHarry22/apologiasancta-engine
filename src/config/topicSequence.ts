/**
 * Topic Sequence Configuration
 * 
 * Defines the order topics should be presented in a quiz session.
 * After completing all questions in a topic, the engine moves to the next topic.
 */

export interface TopicSequenceConfig {
  /** Ordered list of topic IDs for sequential play */
  topicSequence: string[];
  
  /** Time (ms) to display topic summary before auto-advancing (0 = manual only) */
  topicSummaryDisplayTimeMs: number;
  
  /** Whether to auto-advance to next topic after summary */
  autoAdvance: boolean;
  
  /** Whether to loop back to first topic when series is complete */
  loopOnComplete: boolean;
}

/** Default configuration - can be overridden via API or environment */
const defaultConfig: TopicSequenceConfig = {
  topicSequence: [],  // Empty = use all topics in alphabetical order
  topicSummaryDisplayTimeMs: 7000,
  autoAdvance: true,
  loopOnComplete: false,
};

/** Current active configuration */
let currentConfig: TopicSequenceConfig = { ...defaultConfig };

/**
 * Get current topic sequence configuration
 */
export function getTopicSequenceConfig(): TopicSequenceConfig {
  return { ...currentConfig };
}

/**
 * Update topic sequence configuration (partial update)
 */
export function setTopicSequenceConfig(update: Partial<TopicSequenceConfig>): TopicSequenceConfig {
  currentConfig = {
    ...currentConfig,
    ...update,
  };
  console.log("[TopicSequence] Config updated:", currentConfig);
  return { ...currentConfig };
}

/**
 * Reset to default configuration
 */
export function resetTopicSequenceConfig(): TopicSequenceConfig {
  currentConfig = { ...defaultConfig };
  return { ...currentConfig };
}

/**
 * Get next topic ID in sequence after the given topic
 * Returns null if there's no next topic (end of series)
 */
export function getNextTopicId(currentTopicId: string, availableTopicIds: string[]): string | null {
  const sequence = currentConfig.topicSequence.length > 0 
    ? currentConfig.topicSequence 
    : availableTopicIds.sort();
  
  const currentIndex = sequence.indexOf(currentTopicId);
  
  if (currentIndex === -1) {
    // Current topic not in sequence, return first topic
    return sequence[0] || null;
  }
  
  const nextIndex = currentIndex + 1;
  
  if (nextIndex >= sequence.length) {
    // End of series
    if (currentConfig.loopOnComplete) {
      return sequence[0] || null;
    }
    return null;
  }
  
  return sequence[nextIndex];
}

/**
 * Get first topic ID in sequence
 */
export function getFirstTopicId(availableTopicIds: string[]): string | null {
  const sequence = currentConfig.topicSequence.length > 0 
    ? currentConfig.topicSequence 
    : availableTopicIds.sort();
  
  return sequence[0] || null;
}

/**
 * Check if topic is last in sequence
 */
export function isLastTopic(topicId: string, availableTopicIds: string[]): boolean {
  const sequence = currentConfig.topicSequence.length > 0 
    ? currentConfig.topicSequence 
    : availableTopicIds.sort();
  
  const index = sequence.indexOf(topicId);
  return index === sequence.length - 1;
}
