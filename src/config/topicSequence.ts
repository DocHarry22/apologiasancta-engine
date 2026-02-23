/**
 * Topic Sequence Configuration
 * 
 * Defines the order topics should be presented in a quiz session.
 * After completing all questions in a topic, the engine moves to the next topic.
 */

import type { LoopMode } from "../types/quiz";

export interface TopicSequenceConfig {
  /** Ordered list of topic IDs for sequential play */
  topicSequence: string[];
  
  /** Time (ms) to display congrats message after topic completes */
  congratsDisplayTimeMs: number;
  
  /** Time (seconds) for countdown before next topic starts */
  countdownSeconds: number;
  
  /** Whether to auto-advance to next topic after congrats + countdown */
  autoAdvance: boolean;
  
  /** Loop mode for current topic: "off", "once", "infinite", or number */
  topicLoopMode: LoopMode;
  
  /** Remaining repeats for current topic (when using numbered mode) */
  topicRepeatsRemaining: number;
  
  /** Loop mode for all topics: "off", "once", "infinite", or number */  
  seriesLoopMode: LoopMode;
  
  /** Remaining repeats for series (when using numbered mode) */
  seriesRepeatsRemaining: number;
}

/** Default configuration - can be overridden via API or environment */
const defaultConfig: TopicSequenceConfig = {
  topicSequence: [],  // Empty = use all topics in alphabetical order
  congratsDisplayTimeMs: 5000,  // 5 seconds
  countdownSeconds: 10,         // 10 seconds countdown
  autoAdvance: true,
  topicLoopMode: "off",
  topicRepeatsRemaining: 0,
  seriesLoopMode: "off",
  seriesRepeatsRemaining: 0,
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
    // End of series - do not loop here, let caller handle via shouldRepeatSeries()
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

/**
 * Set topic loop mode
 */
export function setTopicLoopMode(mode: LoopMode): TopicSequenceConfig {
  currentConfig.topicLoopMode = mode;
  if (typeof mode === "number") {
    currentConfig.topicRepeatsRemaining = mode;
  } else {
    currentConfig.topicRepeatsRemaining = 0;
  }
  console.log(`[TopicSequence] Topic loop mode set to: ${mode}`);
  return { ...currentConfig };
}

/**
 * Set series loop mode
 */
export function setSeriesLoopMode(mode: LoopMode): TopicSequenceConfig {
  currentConfig.seriesLoopMode = mode;
  if (typeof mode === "number") {
    currentConfig.seriesRepeatsRemaining = mode;
  } else {
    currentConfig.seriesRepeatsRemaining = 0;
  }
  console.log(`[TopicSequence] Series loop mode set to: ${mode}`);
  return { ...currentConfig };
}

/**
 * Check if topic should repeat based on current loop mode
 */
export function shouldRepeatTopic(): boolean {
  const mode = currentConfig.topicLoopMode;
  
  if (mode === "off") return false;
  if (mode === "infinite") return true;
  if (mode === "once") {
    // Once means repeat one more time, then stop
    currentConfig.topicLoopMode = "off";
    return true;
  }
  if (typeof mode === "number" && currentConfig.topicRepeatsRemaining > 0) {
    currentConfig.topicRepeatsRemaining--;
    if (currentConfig.topicRepeatsRemaining === 0) {
      currentConfig.topicLoopMode = "off";
    }
    return true;
  }
  return false;
}

/**
 * Check if series should repeat based on current loop mode
 */
export function shouldRepeatSeries(): boolean {
  const mode = currentConfig.seriesLoopMode;
  
  if (mode === "off") return false;
  if (mode === "infinite") return true;
  if (mode === "once") {
    // Once means repeat one more time, then stop
    currentConfig.seriesLoopMode = "off";
    return true;
  }
  if (typeof mode === "number" && currentConfig.seriesRepeatsRemaining > 0) {
    currentConfig.seriesRepeatsRemaining--;
    if (currentConfig.seriesRepeatsRemaining === 0) {
      currentConfig.seriesLoopMode = "off";
    }
    return true;
  }
  return false;
}

/**
 * Set countdown seconds
 */
export function setCountdownSeconds(seconds: number): TopicSequenceConfig {
  currentConfig.countdownSeconds = Math.max(1, Math.min(60, seconds));
  console.log(`[TopicSequence] Countdown seconds set to: ${currentConfig.countdownSeconds}`);
  return { ...currentConfig };
}

/**
 * Set congrats display time
 */
export function setCongratsDisplayTime(ms: number): TopicSequenceConfig {
  currentConfig.congratsDisplayTimeMs = Math.max(1000, Math.min(30000, ms));
  console.log(`[TopicSequence] Congrats display time set to: ${currentConfig.congratsDisplayTimeMs}ms`);
  return { ...currentConfig };
}
