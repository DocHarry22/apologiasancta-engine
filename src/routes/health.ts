/**
 * GET /health - Health check endpoint
 */

import { Router, Request, Response } from "express";
import { getClientCount, getClientCountForRoom } from "../sse/broker";
import { getPersistenceStatus } from "../state/persistence";
import { listRooms } from "../state/rooms";
import { getPlayerCount } from "../state/players";
import { getCanonicalContentStatus } from "../content/canonical";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const rooms = listRooms(true);
  const persistence = getPersistenceStatus();
  const canonicalContent = getCanonicalContentStatus();

  const contentReady = !canonicalContent.required || canonicalContent.ready;
  res.status(contentReady ? 200 : 503).json({
    ok: contentReady,
    time: new Date().toISOString(),
    uptime: process.uptime(),
    clients: getClientCount(),
    rooms: {
      total: rooms.length,
      active: rooms.filter((room) => room.isActive).length,
    },
    roomDetails: rooms.map((room) => ({
      roomId: room.roomId,
      name: room.name,
      isActive: room.isActive,
      members: room.playerCount,
      connectedClients: getClientCountForRoom(room.roomId),
      gameplayPlayers: getPlayerCount(room.roomId),
    })),
    persistence: {
      configured: persistence.configured,
      driver: persistence.driver,
      path: persistence.path,
      savePending: persistence.savePending,
      lastSavedAt: persistence.lastSavedAt,
      lastRestoredAt: persistence.lastRestoredAt,
      lastRestoreSucceeded: persistence.lastRestoreSucceeded,
    },
    content: canonicalContent,
  });
});

export default router;
