/**
 * YouTube Live Chat Poller
 * 
 * Polls YouTube Live Chat for answer commands and submits them to the quiz.
 */

import {
  listLiveChatMessages,
  resolveLiveChatIdFromVideoId,
  type LiveChatMessage,
} from "./client";
import { parseChoice, type Choice } from "./parser";
import { submitAnswer } from "../state/players";
import { getCurrentPhase, getQuestionIndex } from "../engine/roundController";

/** Minimum polling interval (YouTube enforces at least 5s) */
const MIN_POLL_INTERVAL_MS = 5000;

/** Maximum polling interval */
const MAX_POLL_INTERVAL_MS = 30000;

/** Default polling interval when API doesn't specify */
const DEFAULT_POLL_INTERVAL_MS = 6000;

/** Poller status */
export interface PollerStatus {
  connected: boolean;
  videoId: string | null;
  liveChatId: string | null;
  lastPollAt: number | null;
  messagesProcessed: number;
  answersSubmitted: number;
  errorCount: number;
  lastError: string | null;
}

/** YouTube Poller class */
export class YouTubePoller {
  private apiKey: string;
  private videoId: string | null = null;
  private liveChatId: string | null = null;
  private pageToken: string | undefined;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS;
  
  /** Track processed message IDs to avoid duplicates */
  private processedMessageIds: Set<string> = new Set();
  
  /** Track which users have answered which questions */
  private userAnswers: Map<string, number> = new Map();
  
  /** Stats */
  private stats = {
    connected: false,
    lastPollAt: null as number | null,
    messagesProcessed: 0,
    answersSubmitted: 0,
    errorCount: 0,
    lastError: null as string | null,
  };

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Connect to a YouTube live stream
   * 
   * @param videoId - YouTube video ID
   * @param liveChatId - Optional pre-resolved live chat ID
   */
  async connect(videoId?: string, liveChatId?: string): Promise<void> {
    // Stop any existing polling
    this.stop();

    try {
      if (liveChatId) {
        // Use provided liveChatId directly
        this.liveChatId = liveChatId;
        this.videoId = videoId || null;
        console.log(`[YouTube] Using provided liveChatId: ${liveChatId}`);
      } else if (videoId) {
        // Resolve liveChatId from video
        console.log(`[YouTube] Resolving liveChatId for video: ${videoId}`);
        this.liveChatId = await resolveLiveChatIdFromVideoId(this.apiKey, videoId);
        this.videoId = videoId;
        console.log(`[YouTube] Resolved liveChatId: ${this.liveChatId}`);
      } else {
        throw new Error("Must provide either videoId or liveChatId");
      }

      // Reset state
      this.pageToken = undefined;
      this.processedMessageIds.clear();
      this.userAnswers.clear();
      this.stats = {
        connected: true,
        lastPollAt: null,
        messagesProcessed: 0,
        answersSubmitted: 0,
        errorCount: 0,
        lastError: null,
      };

      // Start polling
      this.schedulePoll(0);

      console.log("[YouTube] Connected and polling started");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.stats.lastError = message;
      console.error(`[YouTube] Connection failed: ${message}`);
      throw error;
    }
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.stats.connected = false;
    console.log("[YouTube] Polling stopped");
  }

  /**
   * Get current status
   */
  getStatus(): PollerStatus {
    return {
      connected: this.stats.connected,
      videoId: this.videoId,
      liveChatId: this.liveChatId,
      lastPollAt: this.stats.lastPollAt,
      messagesProcessed: this.stats.messagesProcessed,
      answersSubmitted: this.stats.answersSubmitted,
      errorCount: this.stats.errorCount,
      lastError: this.stats.lastError,
    };
  }

  /**
   * Schedule next poll
   */
  private schedulePoll(delayMs: number): void {
    this.pollTimer = setTimeout(() => this.poll(), delayMs);
  }

  /**
   * Poll for new messages
   */
  private async poll(): Promise<void> {
    if (!this.liveChatId || !this.stats.connected) {
      return;
    }

    try {
      const response = await listLiveChatMessages(
        this.apiKey,
        this.liveChatId,
        this.pageToken
      );

      this.stats.lastPollAt = Date.now();
      this.pageToken = response.nextPageToken;

      // Update poll interval based on API recommendation
      this.pollIntervalMs = Math.min(
        MAX_POLL_INTERVAL_MS,
        Math.max(MIN_POLL_INTERVAL_MS, response.pollingIntervalMillis)
      );

      // Process messages
      for (const message of response.items) {
        this.processMessage(message);
      }

      // Reset error count on success
      this.stats.errorCount = 0;

      // Schedule next poll
      this.schedulePoll(this.pollIntervalMs);
    } catch (error) {
      const err = error as Error & { fatal?: boolean };
      const message = err.message || String(error);
      this.stats.lastError = message;
      this.stats.errorCount++;

      console.error(`[YouTube] Poll error (${this.stats.errorCount}): ${message}`);

      // Check for fatal errors (quota exceeded, forbidden)
      if (err.fatal) {
        console.error("[YouTube] Fatal error, stopping poller");
        this.stop();
        return;
      }

      // Exponential backoff up to max interval
      const backoffMs = Math.min(
        MAX_POLL_INTERVAL_MS,
        this.pollIntervalMs * Math.pow(2, Math.min(this.stats.errorCount, 5))
      );

      console.log(`[YouTube] Retrying in ${backoffMs}ms`);
      this.schedulePoll(backoffMs);
    }
  }

  /**
   * Process a single chat message
   */
  private processMessage(message: LiveChatMessage): void {
    // Skip if already processed
    if (this.processedMessageIds.has(message.id)) {
      return;
    }
    this.processedMessageIds.add(message.id);
    
    // Limit set size to prevent memory growth
    if (this.processedMessageIds.size > 10000) {
      const iterator = this.processedMessageIds.values();
      for (let i = 0; i < 5000; i++) {
        const result = iterator.next();
        if (!result.done) {
          this.processedMessageIds.delete(result.value);
        }
      }
    }

    this.stats.messagesProcessed++;

    // Parse for answer command
    const displayMessage = message.snippet.displayMessage;
    const choice = parseChoice(displayMessage);

    if (!choice) {
      return; // No answer command in this message
    }

    // Check if quiz is in OPEN phase
    const phase = getCurrentPhase();
    if (phase !== "OPEN") {
      console.log(`[YouTube] Ignoring answer from ${message.authorDetails.displayName}: phase is ${phase}`);
      return;
    }

    const questionIndex = getQuestionIndex();
    const channelId = message.authorDetails.channelId;
    const displayName = message.authorDetails.displayName;

    // Create unique user ID for YouTube users
    const userId = `yt:${channelId}`;

    // Check if this user already answered this question
    const lastAnsweredQuestion = this.userAnswers.get(channelId);
    if (lastAnsweredQuestion === questionIndex) {
      console.log(`[YouTube] Ignoring duplicate answer from ${displayName} for Q${questionIndex + 1}`);
      return;
    }

    // Submit answer
    const accepted = submitAnswer(questionIndex, userId, displayName, choice);

    if (accepted) {
      this.userAnswers.set(channelId, questionIndex);
      this.stats.answersSubmitted++;
      console.log(`[YouTube] Answer accepted: ${displayName} answered ${choice.toUpperCase()} for Q${questionIndex + 1}`);
    } else {
      console.log(`[YouTube] Answer rejected (duplicate): ${displayName} for Q${questionIndex + 1}`);
    }
  }

  /**
   * Clear answer tracking for a new question
   * Call this when question changes to allow users to answer again
   */
  clearAnswerTracking(): void {
    this.userAnswers.clear();
  }
}

/** Singleton poller instance */
let pollerInstance: YouTubePoller | null = null;

/**
 * Get or create the YouTube poller
 */
export function getPoller(): YouTubePoller | null {
  return pollerInstance;
}

/**
 * Create and initialize a new poller
 */
export function createPoller(apiKey: string): YouTubePoller {
  if (pollerInstance) {
    pollerInstance.stop();
  }
  pollerInstance = new YouTubePoller(apiKey);
  return pollerInstance;
}

/**
 * Stop and destroy the poller
 */
export function destroyPoller(): void {
  if (pollerInstance) {
    pollerInstance.stop();
    pollerInstance = null;
  }
}
