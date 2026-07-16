import type { Request, Response } from "express";
import { verifyJoinToken, type JoinTokenPayload } from "./joinToken";

function extractBearerToken(req: Request): string | undefined {
  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  const body = req.body as { joinToken?: unknown } | undefined;
  return typeof body?.joinToken === "string" ? body.joinToken : undefined;
}

export function requirePlayerAuthorization(
  req: Request,
  res: Response,
  input: { userId: string; roomId?: string; allowDifferentRoom?: boolean; allowExpired?: boolean }
): JoinTokenPayload | null {
  let verification;
  try {
    verification = verifyJoinToken(extractBearerToken(req));
  } catch (error) {
    console.error("[Auth] Player join-token configuration failed", error instanceof Error ? error.message : error);
    res.status(503).json({ ok: false, reason: "player_auth_unavailable", error: "Player authentication is unavailable" });
    return null;
  }

  let payload: JoinTokenPayload | null = null;
  let rejectionReason: "join_token_expired" | "invalid_join_token" = "invalid_join_token";
  if (verification.ok) {
    payload = verification.payload;
  } else if (verification.reason === "expired") {
    rejectionReason = "join_token_expired";
    if (input.allowExpired) payload = verification.payload;
  }
  if (!payload) {
    res.status(401).json({
      ok: false,
      reason: rejectionReason,
      error: rejectionReason === "join_token_expired" ? "Your room session expired. Rejoin the room." : "A valid room session is required.",
    });
    return null;
  }
  if (payload.userId !== input.userId) {
    res.status(401).json({ ok: false, reason: "join_token_user_mismatch", error: "The room session belongs to another player." });
    return null;
  }
  if (input.roomId && !input.allowDifferentRoom && payload.roomId !== input.roomId) {
    res.status(401).json({ ok: false, reason: "join_token_room_mismatch", error: "Rejoin this room before answering." });
    return null;
  }
  return payload;
}
