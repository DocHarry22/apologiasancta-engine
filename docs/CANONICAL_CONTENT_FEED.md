# Canonical published-question feed

The learning platform remains the source of truth. The Engine reads a protected,
server-to-server feed and keeps only a restart-safe runtime cache. Browser and
Android clients must never receive `CONTENT_API_TOKEN` or call this feed.

## Request contract

Configure the full endpoint in `CONTENT_API_URL` (normally
`https://<ui-host>/api/v1/engine/questions`) and its bearer credential in
`CONTENT_API_TOKEN`.

```http
GET /api/v1/engine/questions HTTP/1.1
Accept: application/json
Authorization: Bearer <server-only token>
If-None-Match: "previous-etag"
```

The upstream should return `304 Not Modified` when appropriate. A changed feed
returns `200`, an `ETag`, and:

```json
{
  "version": "2026-07-17T12:00:00.000Z",
  "updatedAt": "2026-07-17T12:00:00.000Z",
  "questions": [
    {
      "id": "stable-question-key",
      "version": 3,
      "topicId": "group-or-live-topic-id",
      "subjectId": "optional-subject-id",
      "groupId": "optional-group-id",
      "lessonId": "optional-lesson-id",
      "difficulty": 3,
      "prompt": "Question text",
      "options": [
        { "id": "option-1", "label": "First answer" },
        { "id": "option-2", "label": "Second answer" },
        { "id": "option-3", "label": "Third answer" },
        { "id": "option-4", "label": "Fourth answer" }
      ],
      "correctOptionId": "option-2",
      "explanation": "Shown only during REVEAL.",
      "sources": ["Source reference"],
      "tags": ["optional-tag"]
    }
  ]
}
```

The protected PostgREST view form is also accepted: a raw array or `{ "data":
[...] }` with `question_id`, `stable_key`, `question_type`, `group_id`, `prompt`,
`correct_answer_explanation`, `updated_at`, and `options` entries containing
`id`, `position`, `content`, and `is_correct`.

The upstream route/view is responsible for selecting only questions that are:

- published;
- active (not retired or quarantined);
- enabled for the `live_quiz` context; and
- currently within any configured availability window.

The Engine defensively excludes rows that explicitly contradict those states.
Malformed rows, duplicate IDs, ambiguous answer keys, same-version content
changes, and version regressions reject the complete refresh.

## Cache and failure behavior

Catalog validation happens before a single atomic replacement. Room pools keep
their immutable selected revisions across refreshes, including the correct
answer used for the current scoring window. ETag, feed version, per-question
version/digest, and timestamps are stored in the existing runtime snapshot; URL
and bearer credential are not.

Timeouts, non-JSON responses, oversize responses, authentication failures, and
invalid feeds retain the last validated catalog. With
`CONTENT_API_REQUIRED=true`, a cold start without a validated feed or persisted
cache fails closed. A stale validated cache remains playable and is visible in
`/health`, `/diagnostics`, and `GET /admin/content/canonical/status`.

Required mode also disables the legacy import, GitHub sync/delete, local clear,
and quiz-set endpoints. Persisted pools without canonical provenance are purged
on adoption. Loss of the canonical checkpoint or active pool returns `503`
instead of silently serving the bundled fixture questions; answers are refused
until a canonical refresh and pool selection recover the room.

Use `POST /admin/content/refresh` for a manual conditional refresh. It preserves
current pools by default. `{"refreshActivePool":true}` is an explicit disruptive
global-pool rebuild and should only be used after coordinating a pause. Set
`CONTENT_API_REFRESH_INTERVAL_MS=0` to disable periodic refresh.

## Secret rotation

1. Issue a new least-privilege feed token on the content API.
2. Update `CONTENT_API_TOKEN` in Render without exposing it to logs or clients.
3. Trigger `POST /admin/content/refresh` and confirm a successful status.
4. Revoke the previous token.

`ADMIN_TOKEN`, `CONTENT_API_TOKEN`, `PLAYER_JOIN_SECRET`, and any Supabase
service-role credential must be independent random values.
