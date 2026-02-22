/**
 * SSE Broker - manages client connections and broadcasts
 * Supports personalized streams with userId parameter
 */

import type { Response } from "express";
import { getState } from "../state/store";
import { getPlayerInfo } from "../state/players";
import type { QuizState } from "../types/quiz";

/** SSE Client connection */
interface SSEClient {
  id: string;
  res: Response;
  connectedAt: number;
  /** Optional userId for personalized streams */
  userId?: string;
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
  const state = getState();
  
  if (!client.userId) {
    return state;
  }
  
  const playerInfo = getPlayerInfo(client.userId);
  if (!playerInfo) {
    return state;
  }
  
  return {
    ...state,
    me: playerInfo,
  };
}

/**
 * Add a new SSE client connection
 * @param res - Express Response object
 * @param userId - Optional userId for personalized streams
 */
export function addClient(res: Response, userId?: string): string {
  const id = generateClientId();
  const client: SSEClient = {
    id,
    res,
    connectedAt: Date.now(),
    userId,
  };

  clients.set(id, client);
  
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`[SSE] Client connected: ${id}${userId ? ` (userId: ${userId})` : ""} (total: ${clients.size})`);
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
 * Broadcast state update to all connected clients
 * Each client gets personalized state if they have userId
 */
export function broadcast(state: unknown): void {
  const failedClients: string[] = [];
  const baseState = state as QuizState;

  clients.forEach((client) => {
    // Personalize state for clients with userId
    let clientState = baseState;
    if (client.userId) {
      const playerInfo = getPlayerInfo(client.userId);
      if (playerInfo) {
        clientState = { ...baseState, me: playerInfo };
      }
    }
    
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
