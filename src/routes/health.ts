/**
 * GET /health - Health check endpoint
 */

import { Router, Request, Response } from "express";
import { getClientCount, getClientCountForRoom } from "../sse/broker";
import { getPersistenceStatus } from "../state/persistence";
import { listRooms } from "../state/rooms";
import { getPlayerCount } from "../state/players";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const rooms = listRooms(true);
  const persistence = getPersistenceStatus();

  res.json({
    ok: true,
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
      path: persistence.path,
      savePending: persistence.savePending,
      lastSavedAt: persistence.lastSavedAt,
      lastRestoredAt: persistence.lastRestoredAt,
      lastRestoreSucceeded: persistence.lastRestoreSucceeded,
    },
  });
});

export default router;
