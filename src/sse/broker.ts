/**
 * SSE Broker - manages client connections and broadcasts
 * Supports personalized streams with userId parameter
 */

import type { Response } from "express";
import { getStateForRoom } from "../state/store";
import { getPlayerInfo } from "../state/players";
import type { QuizState } from "../types/quiz";
import { DEFAULT_ROOM_ID } from "../state/rooms";

/** SSE Client connection */
interface SSEClient {
  id: string;
  res: Response;
  connectedAt: number;
  /** Optional userId for personalized streams */
  userId?: string;
  roomId: string;
}

/** Active client connections */
const clients: Map<string, SSEClient> = new Map();

/** Heartbeat interval (15 seconds) */
const HEARTBEAT_INTERVAL_MS = 15 * 1000;

/** Heartbeat timer reference */
let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * Generate unique client ID
 */
function generateClientId(): string {
  return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Send SSE message (uses default event type)
 */
function sendMessage(client: SSEClient, data: unknown): boolean {
  try {
    const payload = JSON.stringify(data);
    client.res.write(`data: ${payload}\n\n`);
    return true;
  } catch (error) {
    console.error(`Failed to send to client ${client.id}:`, error);
    return false;
  }
}

/**
 * Send SSE comment (for heartbeat/keepalive)
 */
function sendComment(client: SSEClient, comment: string): boolean {
  try {
    client.res.write(`: ${comment}\n\n`);
    return true;
  } catch (error) {
    console.error(`Failed to send comment to client ${client.id}:`, error);
    return false;
  }
}

/**
 * Get personalized state for a client
 * Adds 'me' field if client has userId
 */
function getPersonalizedState(client: SSEClient): QuizState {
  const state = getStateForRoom(client.roomId);
  
  if (!client.userId) {
    return state;
  }
  
  const playerInfo = getPlayerInfo(client.userId, client.roomId);
  if (!playerInfo) {
    return state;
  }
  
  return {
    ...state,
    me: {
      ...playerInfo,
      roomId: client.roomId,
      roomName: state.roomName,
    },
  };
}

/**
 * Add a new SSE client connection
 * @param res - Express Response object
 * @param userId - Optional userId for personalized streams
 */
export function addClient(res: Response, userId?: string, roomId: string = DEFAULT_ROOM_ID): string {
  const id = generateClientId();
  const client: SSEClient = {
    id,
    res,
    connectedAt: Date.now(),
    userId,
    roomId,
  };

  clients.set(id, client);
  
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`[SSE] Client connected: ${id}${userId ? ` (userId: ${userId})` : ""} room=${roomId} (total: ${clients.size})`);
  }

  // Send current state immediately on connect (personalized if userId provided)
  const state = getPersonalizedState(client);
  sendMessage(client, state);

  // Start heartbeat if this is the first client
  if (clients.size === 1) {
    startHeartbeat();
  }

  return id;
}

/**
 * Remove a client connection
 */
export function removeClient(id: string): void {
  const client = clients.get(id);
  if (client) {
    clients.delete(id);
    
    const isDev = process.env.NODE_ENV !== "production";
    if (isDev) {
      console.log(`[SSE] Client disconnected: ${id} (total: ${clients.size})`);
    }

    // Stop heartbeat if no more clients
    if (clients.size === 0) {
      stopHeartbeat();
    }
  }
}

/**
 * Broadcast state update to clients in a specific room (or all rooms if omitted).
 * Each client receives fresh, personalized state so that per-user 'me' data
 * can be injected server-side.
 */
export function broadcast(roomId?: string): void {
  const failedClients: string[] = [];

  clients.forEach((client) => {
    if (roomId && client.roomId !== roomId) {
      return;
    }

    const clientState = getPersonalizedState(client);
    
    const success = sendMessage(client, clientState);
    if (!success) {
      failedClients.push(client.id);
    }
  });

  // Remove failed clients
  failedClients.forEach((id) => removeClient(id));

  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`[SSE] Broadcast to ${clients.size} clients`);
  }
}

/**
 * Broadcast a typed event to all connected clients.
 * Used for special events like topicComplete, seriesComplete.
 * Events are sent with their type field preserved.
 */
export function broadcastEvent<T extends { type: string }>(event: T, roomId?: string): void {
  const failedClients: string[] = [];

  clients.forEach((client) => {
    if (roomId && client.roomId !== roomId) {
      return;
    }

    const success = sendMessage(client, event as Record<string, unknown>);
    if (!success) {
      failedClients.push(client.id);
    }
  });

  // Remove failed clients
  failedClients.forEach((id) => removeClient(id));

  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`[SSE] Event broadcast (${event.type}) to ${clients.size} clients`);
  }
}

/**
 * Start heartbeat timer
 */
function startHeartbeat(): void {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const failedClients: string[] = [];

    clients.forEach((client) => {
      const success = sendComment(client, `heartbeat ${Date.now()}`);
      if (!success) {
        failedClients.push(client.id);
      }
    });

    // Remove failed clients
    failedClients.forEach((id) => removeClient(id));

    const isDev = process.env.NODE_ENV !== "production";
    if (isDev) {
      console.log(`[SSE] Heartbeat sent to ${clients.size} clients`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log("[SSE] Heartbeat started");
  }
}

/**
 * Stop heartbeat timer
 */
function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    
    const isDev = process.env.NODE_ENV !== "production";
    if (isDev) {
      console.log("[SSE] Heartbeat stopped");
    }
  }
}

/**
 * Get current client count
 */
export function getClientCount(): number {
  return clients.size;
}

export function getClientCountForRoom(roomId: string): number {
  let count = 0;
  clients.forEach((client) => {
    if (client.roomId === roomId) {
      count += 1;
    }
  });

  return count;
}

export function resetBrokerForTests(): void {
  clients.clear();
  stopHeartbeat();
}
