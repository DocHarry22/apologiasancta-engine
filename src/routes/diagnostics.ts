import { Router } from "express";
import { allowedOrigins } from "../config/cors";
import { getPersistenceStatus } from "../state/persistence";
import { isJoinTokenConfigured } from "../security/joinToken";
import { isAccountIdentityConfigured, isAccountIdentityEnabled } from "../security/accountIdentity";
import { isQuizAutoStartEnabled, isQuizContinuousEnabled } from "../config/quizRuntime";
import { getCanonicalContentStatus } from "../content/canonical";
import { isAdminTokenConfigured } from "../security/adminToken";

const router = Router();

router.get("/", (_req, res) => {
  const persistence = getPersistenceStatus();
  const canonicalContent = getCanonicalContentStatus();
  res.json({
    ok: true,
    service: "apologiasancta-engine",
    version: process.env.npm_package_version ?? "1.0.0",
    environment: process.env.NODE_ENV ?? "development",
    commit: (process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT_SHA ?? "unknown").slice(0, 12),
    uptimeSeconds: Math.floor(process.uptime()),
    readiness: {
      adminAuthentication: isAdminTokenConfigured(),
      playerAuthentication: isJoinTokenConfigured() || process.env.NODE_ENV !== "production",
      accountIdentityExchange: !isAccountIdentityEnabled() || isAccountIdentityConfigured(),
      quizAutoStart: isQuizAutoStartEnabled(),
      quizContinuous: isQuizContinuousEnabled(),
      persistence: persistence.configured,
      persistenceDriver: persistence.driver,
      corsOriginCount: allowedOrigins.length,
      githubContentSync: Boolean((process.env.GITHUB_CONTENT_OWNER ?? process.env.GITHUB_OWNER)?.trim()),
      canonicalContent: !canonicalContent.required || canonicalContent.ready,
      youtubeIntegration: Boolean(process.env.YOUTUBE_API_KEY?.trim()),
    },
    features: {
      accountIdentityExchange: isAccountIdentityEnabled(),
      quizAutoStart: isQuizAutoStartEnabled(),
      quizContinuous: isQuizContinuousEnabled(),
    },
    content: canonicalContent,
  });
});

export default router;
