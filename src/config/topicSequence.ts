/**
 * Topic Sequence Configuration
 * 
 * Defines the order topics should be presented in a quiz session.
 * After completing all questions in a topic, the engine moves to the next topic.
 */

import type { LoopMode } from "../types/quiz";
import { DEFAULT_ROOM_ID } from "../state/rooms";
import { schedulePersistence } from "../state/persistence";

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

export interface PersistedTopicSequenceSnapshot {
  rooms?: Array<{
    roomId: string;
    config: TopicSequenceConfig;
  }>;
  currentConfig?: TopicSequenceConfig;
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

const roomConfigs = new Map<string, TopicSequenceConfig>();

function cloneConfig(config: TopicSequenceConfig): TopicSequenceConfig {
  return {
    ...config,
    topicSequence: [...config.topicSequence],
  };
}

function getStoredConfig(roomId: string = DEFAULT_ROOM_ID): TopicSequenceConfig {
  let config = roomConfigs.get(roomId);
  if (!config) {
    config = cloneConfig(defaultConfig);
    roomConfigs.set(roomId, config);
  }
  return config;
}

function getSequence(config: TopicSequenceConfig, availableTopicIds: string[]): string[] {
  return config.topicSequence.length > 0 ? [...config.topicSequence] : [...availableTopicIds].sort();
}

/**
 * Get current topic sequence configuration
 */
export function getTopicSequenceConfig(roomId: string = DEFAULT_ROOM_ID): TopicSequenceConfig {
  return cloneConfig(getStoredConfig(roomId));
}

/**
 * Update topic sequence configuration (partial update)
 */
export function setTopicSequenceConfig(
  update: Partial<TopicSequenceConfig>,
  roomId: string = DEFAULT_ROOM_ID
): TopicSequenceConfig {
  const currentConfig = getStoredConfig(roomId);
  const nextConfig: TopicSequenceConfig = {
    ...currentConfig,
    ...update,
    topicSequence: update.topicSequence ? [...update.topicSequence] : [...currentConfig.topicSequence],
  };
  roomConfigs.set(roomId, nextConfig);
  schedulePersistence();
  console.log(`[TopicSequence:${roomId}] Config updated:`, nextConfig);
  return cloneConfig(nextConfig);
}

/**
 * Reset to default configuration
 */
export function resetTopicSequenceConfig(roomId: string = DEFAULT_ROOM_ID): TopicSequenceConfig {
  const nextConfig = cloneConfig(defaultConfig);
  roomConfigs.set(roomId, nextConfig);
  schedulePersistence();
  return cloneConfig(nextConfig);
}

/**
 * Get next topic ID in sequence after the given topic
 * Returns null if there's no next topic (end of series)
 */
export function getNextTopicId(
  currentTopicId: string,
  availableTopicIds: string[],
  roomId: string = DEFAULT_ROOM_ID
): string | null {
  const sequence = getSequence(getStoredConfig(roomId), availableTopicIds);
  
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
export function getFirstTopicId(
  availableTopicIds: string[],
  roomId: string = DEFAULT_ROOM_ID
): string | null {
  const sequence = getSequence(getStoredConfig(roomId), availableTopicIds);
  
  return sequence[0] || null;
}

/**
 * Check if topic is last in sequence
 */
export function isLastTopic(
  topicId: string,
  availableTopicIds: string[],
  roomId: string = DEFAULT_ROOM_ID
): boolean {
  const sequence = getSequence(getStoredConfig(roomId), availableTopicIds);
  
  const index = sequence.indexOf(topicId);
  return index === sequence.length - 1;
}

/**
 * Set topic loop mode
 */
export function setTopicLoopMode(mode: LoopMode, roomId: string = DEFAULT_ROOM_ID): TopicSequenceConfig {
  const currentConfig = getStoredConfig(roomId);
  currentConfig.topicLoopMode = mode;
  if (typeof mode === "number") {
    currentConfig.topicRepeatsRemaining = mode;
  } else {
    currentConfig.topicRepeatsRemaining = 0;
  }
  schedulePersistence();
  console.log(`[TopicSequence:${roomId}] Topic loop mode set to: ${mode}`);
  return cloneConfig(currentConfig);
}

/**
 * Set series loop mode
 */
export function setSeriesLoopMode(mode: LoopMode, roomId: string = DEFAULT_ROOM_ID): TopicSequenceConfig {
  const currentConfig = getStoredConfig(roomId);
  currentConfig.seriesLoopMode = mode;
  if (typeof mode === "number") {
    currentConfig.seriesRepeatsRemaining = mode;
  } else {
    currentConfig.seriesRepeatsRemaining = 0;
  }
  schedulePersistence();
  console.log(`[TopicSequence:${roomId}] Series loop mode set to: ${mode}`);
  return cloneConfig(currentConfig);
}

/**
 * Check if topic should repeat based on current loop mode
 */
export function shouldRepeatTopic(roomId: string = DEFAULT_ROOM_ID): boolean {
  const currentConfig = getStoredConfig(roomId);
  const mode = currentConfig.topicLoopMode;
  
  if (mode === "off") return false;
  if (mode === "infinite") return true;
  if (mode === "once") {
    currentConfig.topicLoopMode = "off";
    schedulePersistence();
    return true;
  }
  if (typeof mode === "number" && currentConfig.topicRepeatsRemaining > 0) {
    currentConfig.topicRepeatsRemaining--;
    if (currentConfig.topicRepeatsRemaining === 0) {
      currentConfig.topicLoopMode = "off";
    }
    schedulePersistence();
    return true;
  }
  return false;
}

/**
 * Check if series should repeat based on current loop mode
 */
export function shouldRepeatSeries(roomId: string = DEFAULT_ROOM_ID): boolean {
  const currentConfig = getStoredConfig(roomId);
  const mode = currentConfig.seriesLoopMode;
  
  if (mode === "off") return false;
  if (mode === "infinite") return true;
  if (mode === "once") {
    currentConfig.seriesLoopMode = "off";
    schedulePersistence();
    return true;
  }
  if (typeof mode === "number" && currentConfig.seriesRepeatsRemaining > 0) {
    currentConfig.seriesRepeatsRemaining--;
    if (currentConfig.seriesRepeatsRemaining === 0) {
      currentConfig.seriesLoopMode = "off";
    }
    schedulePersistence();
    return true;
  }
  return false;
}

/**
 * Set countdown seconds
 */
export function setCountdownSeconds(seconds: number, roomId: string = DEFAULT_ROOM_ID): TopicSequenceConfig {
  const currentConfig = getStoredConfig(roomId);
  currentConfig.countdownSeconds = Math.max(1, Math.min(60, seconds));
  schedulePersistence();
  console.log(`[TopicSequence:${roomId}] Countdown seconds set to: ${currentConfig.countdownSeconds}`);
  return cloneConfig(currentConfig);
}

/**
 * Set congrats display time
 */
export function setCongratsDisplayTime(ms: number, roomId: string = DEFAULT_ROOM_ID): TopicSequenceConfig {
  const currentConfig = getStoredConfig(roomId);
  currentConfig.congratsDisplayTimeMs = Math.max(1000, Math.min(30000, ms));
  schedulePersistence();
  console.log(`[TopicSequence:${roomId}] Congrats display time set to: ${currentConfig.congratsDisplayTimeMs}ms`);
  return cloneConfig(currentConfig);
}

export function getTopicSequencePersistenceSnapshot(): PersistedTopicSequenceSnapshot {
  return {
    rooms: [...roomConfigs.entries()].map(([roomId, config]) => ({
      roomId,
      config: cloneConfig(config),
    })),
    currentConfig: cloneConfig(getStoredConfig(DEFAULT_ROOM_ID)),
  };
}

export function hydrateTopicSequencePersistenceSnapshot(
  snapshot: PersistedTopicSequenceSnapshot | null | undefined
): void {
  roomConfigs.clear();

  if (!snapshot) {
    roomConfigs.set(DEFAULT_ROOM_ID, cloneConfig(defaultConfig));
    return;
  }

  if (snapshot.rooms && snapshot.rooms.length > 0) {
    for (const entry of snapshot.rooms) {
      roomConfigs.set(entry.roomId, {
        ...cloneConfig(defaultConfig),
        ...entry.config,
        topicSequence: [...(entry.config.topicSequence || [])],
      });
    }
  } else if (snapshot.currentConfig) {
    roomConfigs.set(DEFAULT_ROOM_ID, {
      ...cloneConfig(defaultConfig),
      ...snapshot.currentConfig,
      topicSequence: [...(snapshot.currentConfig.topicSequence || [])],
    });
  }

  if (!roomConfigs.has(DEFAULT_ROOM_ID)) {
    roomConfigs.set(DEFAULT_ROOM_ID, cloneConfig(defaultConfig));
  }
}
