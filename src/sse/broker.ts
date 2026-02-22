/**
 * SSE Broker - manages client connections and broadcasts
 */

import type { Response } from "express";
import { getState } from "../state/store";

/** SSE Client connection */
interface SSEClient {
  id: string;
  res: Response;
  connectedAt: number;
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
 * Add a new SSE client connection
 */
export function addClient(res: Response): string {
  const id = generateClientId();
  const client: SSEClient = {
    id,
    res,
    connectedAt: Date.now(),
  };

  clients.set(id, client);
  
  const isDev = process.env.NODE_ENV !== "production";
  if (isDev) {
    console.log(`[SSE] Client connected: ${id} (total: ${clients.size})`);
  }

  // Send current state immediately on connect
  const state = getState();
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
 */
export function broadcast(state: unknown): void {
  const failedClients: string[] = [];

  clients.forEach((client) => {
    const success = sendMessage(client, state);
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
