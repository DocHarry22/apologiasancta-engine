export const KNOWLEDGE_ADVANCED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_authoring_proposals (
  id TEXT PRIMARY KEY,
  proposal_type TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  input_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposal JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','accepted','rejected','expired')),
  proposed_by TEXT NOT NULL,
  reviewed_by TEXT,
  review_notes TEXT,
  accepted_mutation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_authoring_proposals_status
  ON knowledge_authoring_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_authoring_proposals_type
  ON knowledge_authoring_proposals(proposal_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_authoring_proposals_input_hash
  ON knowledge_authoring_proposals(input_hash);

CREATE TABLE IF NOT EXISTS knowledge_query_observations (
  id BIGSERIAL PRIMARY KEY,
  operation TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  node_count INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  edge_count INTEGER NOT NULL DEFAULT 0 CHECK (edge_count >= 0),
  result_count INTEGER NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_query_observations_operation
  ON knowledge_query_observations(operation, created_at DESC);

COMMENT ON TABLE knowledge_authoring_proposals IS
  'Untrusted AI/heuristic authoring proposals. Acceptance records editorial intent/mutation IDs only and never auto-publishes canonical knowledge.';
COMMENT ON TABLE knowledge_query_observations IS
  'Bounded non-sensitive Knowledge Engine query telemetry. Payload text and credentials are never stored.';
`;
