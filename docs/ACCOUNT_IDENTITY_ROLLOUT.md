# Account-linked player identity rollout

This is an additive, opt-in bridge between the authenticated Next.js account authority and the live quiz Engine. It does not replace guest registration or room-scoped join tokens.

## Trust boundary

- Only an authenticated Next.js server route may create an account assertion.
- `ACCOUNT_IDENTITY_SECRET` is a separate 32+ byte random secret stored in Hostinger's server environment and Render's secret manager.
- The Engine rejects `ACCOUNT_IDENTITY_SECRET` when it matches `PLAYER_JOIN_SECRET`; when account identity is enabled, this fails startup and reports the exchange as not ready without exposing either secret.
- Never prefix the secret with `NEXT_PUBLIC_`, send it to a browser, put it in local storage, or bundle it into Capacitor/Android.
- `subject` must be the UI database's opaque, immutable account ID. Do not use an email address, username, display name, or other mutable or identifying value.
- The browser may receive the resulting ordinary room-scoped `joinToken`; it must never receive the account assertion or signing secret.

## Assertion contract

The compact assertion is:

```text
base64url(UTF8(JSON payload)) + "." + base64url(HMAC-SHA256(secret, encodedPayload))
```

The JSON payload uses Unix seconds and exactly these fields:

```json
{
  "version": 1,
  "issuer": "apologia-ui",
  "subject": "opaque-account-uuid",
  "displayName": "Public_Name",
  "roomId": "global",
  "issuedAt": 1784188800,
  "expiresAt": 1784188920,
  "nonce": "base64url-random-18-bytes"
}
```

Contract rules:

- `issuer` must exactly equal `ACCOUNT_IDENTITY_ISSUER`.
- `subject` is 8-128 ASCII letters, digits, colons, underscores or hyphens.
- `displayName` is already normalized and must match `[A-Za-z0-9_]{3,20}`.
- `roomId` is signed and must match `[a-z0-9-]{3,40}`.
- `nonce` is a new base64url value of at least 16 characters for every assertion.
- Assertion lifetime must be positive and no longer than `ACCOUNT_IDENTITY_ASSERTION_TTL_SECONDS` (default 120, hard maximum 300 seconds).
- Clock skew defaults to 15 seconds. Keep Hostinger and Render clocks synchronized.

The Next.js server then calls:

```http
POST https://apologiasancta-engine.onrender.com/identity/exchange
Content-Type: application/json

{"assertion":"<compact assertion>"}
```

On success the Engine returns an opaque `acct_<uuid>` `userId`, the safe public `username`, signed `roomId`, memberships and a normal room `joinToken`. Reissuing a fresh assertion for the same `(issuer, subject)` returns the same Engine `userId`, including after a restart. The external subject is never returned or used on leaderboards.

Within one Engine process, exact retries of the same assertion return the same join token until the assertion expires. Reusing a nonce with different signed content returns `409 identity_assertion_nonce_reused`. Replay state is process-local by design; the short expiry and server-only TLS call are the primary replay controls. Run a single Engine instance until replay state and room orchestration use a shared store.

The exchange route also has a coarse shared-server rate limit. Because authenticated requests are sent by the Next.js server, many learners can legitimately share one Hostinger egress IP. The documented defaults are `RATE_LIMIT_IDENTITY_EXCHANGE_MAX=6000` per `RATE_LIMIT_IDENTITY_EXCHANGE_WINDOW_MS=600000`; size this above the largest expected room/reconnect burst and monitor 429 responses. Assertion verification and nonce replay controls remain mandatory regardless of this ceiling.

## Safe deployment order

1. Deploy this Engine build with `ACCOUNT_IDENTITY_ENABLED=false`. Guest behavior is unchanged.
2. Generate a new random secret of at least 32 bytes and add it to Render as `ACCOUNT_IDENTITY_SECRET`. Do not reuse `PLAYER_JOIN_SECRET`.
3. Add the same secret to the Hostinger Next.js server environment, implement the signer in a server-only module and expose an authenticated UI route that performs the exchange server-to-server.
4. Keep both sides on `ACCOUNT_IDENTITY_ISSUER=apologia-ui` and an assertion TTL of 120 seconds or less.
5. Set `ACCOUNT_IDENTITY_ENABLED=true` on Render and deploy. Confirm `/diagnostics` reports `features.accountIdentityExchange=true` and `readiness.accountIdentityExchange=true` without exposing any secret.
6. Enable the UI account-player feature for staff first. Verify stable reissue, room join, reconnect and leaderboard attribution before wider rollout.
7. Retain guest fallback until existing anonymous sessions age out and account linking UX has been reviewed.

## Persistence and rollback

Mappings are an optional `accountIdentities` section inside the existing atomic runtime snapshot. Old snapshots restore without migration, and older Engine builds ignore the additive field. The exchange forces a persistence flush before returning credentials, so a successful response has a durable mapping when PostgreSQL is healthy.

This remains a whole-runtime, single-instance persistence model. A database outage makes account exchange return `503` while guest registration remains available. To roll back, disable `ACCOUNT_IDENTITY_ENABLED`; mappings remain in the snapshot for later re-enable and existing join tokens continue to work until their normal expiry.

Expired join tokens are now narrower: `/register/me` and rename require a current token. An expired guest token may only refresh the same current display name through registration or a room join; it cannot rename the player or revive an identity after the display name has changed. An account-linked player's expired token can never self-renew through guest registration/join routes; the authenticated UI server must issue a fresh account assertion and call `/identity/exchange` again.
