/**
 * YouTube Data API v3 Client
 * 
 * Provides functions for interacting with YouTube Live Chat API.
 * Uses native fetch (Node 18+).
 */

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/** YouTube API error response */
export interface YouTubeApiError {
  code: number;
  message: string;
  errors?: Array<{
    domain: string;
    reason: string;
    message: string;
  }>;
}

/** Live chat message item from API */
export interface LiveChatMessage {
  kind: string;
  etag: string;
  id: string;
  snippet: {
    type: string;
    liveChatId: string;
    authorChannelId: string;
    publishedAt: string;
    hasDisplayContent: boolean;
    displayMessage: string;
    textMessageDetails?: {
      messageText: string;
    };
  };
  authorDetails: {
    channelId: string;
    channelUrl: string;
    displayName: string;
    profileImageUrl: string;
    isVerified: boolean;
    isChatOwner: boolean;
    isChatSponsor: boolean;
    isChatModerator: boolean;
  };
}

/** Response from liveChatMessages.list */
export interface LiveChatMessagesResponse {
  kind: string;
  etag: string;
  nextPageToken?: string;
  pollingIntervalMillis: number;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: LiveChatMessage[];
}

/** Response from videos.list */
interface VideoListResponse {
  kind: string;
  items: Array<{
    id: string;
    liveStreamingDetails?: {
      activeLiveChatId?: string;
      actualStartTime?: string;
      scheduledStartTime?: string;
      concurrentViewers?: string;
    };
  }>;
}

/**
 * Resolve liveChatId from a video ID
 * 
 * @param apiKey - YouTube Data API key
 * @param videoId - YouTube video ID
 * @returns The active live chat ID
 * @throws Error if video not found or not a live stream
 */
export async function resolveLiveChatIdFromVideoId(
  apiKey: string,
  videoId: string
): Promise<string> {
  const url = new URL(`${YOUTUBE_API_BASE}/videos`);
  url.searchParams.set("part", "liveStreamingDetails");
  url.searchParams.set("id", videoId);
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString());

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const apiError = (errorBody as { error?: YouTubeApiError }).error;
    throw new Error(
      `YouTube API error: ${apiError?.message || response.statusText} (${response.status})`
    );
  }

  const data = (await response.json()) as VideoListResponse;

  if (!data.items || data.items.length === 0) {
    throw new Error(`Video not found: ${videoId}`);
  }

  const video = data.items[0];
  const liveChatId = video.liveStreamingDetails?.activeLiveChatId;

  if (!liveChatId) {
    throw new Error(
      `No active live chat for video ${videoId}. ` +
      `The stream may not be live or may not have chat enabled.`
    );
  }

  return liveChatId;
}

/**
 * List live chat messages
 * 
 * @param apiKey - YouTube Data API key
 * @param liveChatId - Live chat ID
 * @param pageToken - Optional page token for pagination
 * @returns Messages response with items, nextPageToken, and pollingIntervalMillis
 */
export async function listLiveChatMessages(
  apiKey: string,
  liveChatId: string,
  pageToken?: string
): Promise<{
  items: LiveChatMessage[];
  nextPageToken?: string;
  pollingIntervalMillis: number;
}> {
  const url = new URL(`${YOUTUBE_API_BASE}/liveChat/messages`);
  url.searchParams.set("liveChatId", liveChatId);
  url.searchParams.set("part", "snippet,authorDetails");
  url.searchParams.set("key", apiKey);

  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const apiError = (errorBody as { error?: YouTubeApiError }).error;
    
    // Check for quota/forbidden errors
    const reason = apiError?.errors?.[0]?.reason;
    if (reason === "quotaExceeded" || reason === "forbidden" || response.status === 403) {
      const error = new Error(
        `YouTube API access denied: ${apiError?.message || "Quota exceeded or forbidden"}`
      ) as Error & { fatal: boolean };
      error.fatal = true;
      throw error;
    }
    
    throw new Error(
      `YouTube API error: ${apiError?.message || response.statusText} (${response.status})`
    );
  }

  const data = (await response.json()) as LiveChatMessagesResponse;

  return {
    items: data.items || [],
    nextPageToken: data.nextPageToken,
    pollingIntervalMillis: data.pollingIntervalMillis || 5000,
  };
}
