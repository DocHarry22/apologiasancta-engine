export const KNOWLEDGE_SCHEMA_VERSION = 1;

export const KNOWLEDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_schema_meta (
  singleton SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  canonical_slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  proposition TEXT,
  summary TEXT,
  language TEXT,
  content_state TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_node_aliases (
  id BIGSERIAL PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_type TEXT NOT NULL DEFAULT 'search',
  language TEXT,
  is_preferred BOOLEAN NOT NULL DEFAULT FALSE,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(node_id, alias, alias_type)
);

CREATE TABLE IF NOT EXISTS knowledge_node_versions (
  revision_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(node_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  content_state TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_node_id <> to_node_id)
);

CREATE TABLE IF NOT EXISTS knowledge_edge_versions (
  revision_id TEXT PRIMARY KEY,
  edge_id TEXT NOT NULL REFERENCES knowledge_edges(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(edge_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  edition TEXT,
  language TEXT,
  authority_class TEXT,
  binding_status TEXT,
  licensing_status TEXT NOT NULL DEFAULT 'unknown',
  content_state TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_source_versions (
  revision_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_edge_assertions (
  id TEXT PRIMARY KEY,
  edge_id TEXT NOT NULL REFERENCES knowledge_edges(id) ON DELETE CASCADE,
  asserted_by_type TEXT NOT NULL,
  asserted_by_id TEXT NOT NULL,
  stance TEXT NOT NULL,
  source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  attribution_mode TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'unresolved',
  review_state TEXT NOT NULL DEFAULT 'awaiting_review',
  revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_citations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  edge_assertion_id TEXT REFERENCES knowledge_edge_assertions(id) ON DELETE CASCADE,
  locator TEXT NOT NULL,
  fragment TEXT,
  fragment_mode TEXT NOT NULL DEFAULT 'reference_only',
  attribution_mode TEXT NOT NULL DEFAULT 'source',
  content_hash TEXT,
  review_state TEXT NOT NULL DEFAULT 'unverified',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (node_id IS NOT NULL OR edge_assertion_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS knowledge_assessments (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  lens TEXT NOT NULL,
  position TEXT NOT NULL,
  rationale_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_state TEXT NOT NULL DEFAULT 'awaiting_review',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(node_id, lens)
);

CREATE TABLE IF NOT EXISTS knowledge_claim_family_members (
  family_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  claim_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'member',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (family_node_id, claim_node_id)
);

CREATE TABLE IF NOT EXISTS knowledge_reviews (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_revision_id TEXT NOT NULL,
  review_dimension TEXT NOT NULL,
  state TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  notes TEXT,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_publication_events (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_kind ON knowledge_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_state ON knowledge_nodes(content_state);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_title_lower ON knowledge_nodes(LOWER(title));
CREATE INDEX IF NOT EXISTS idx_knowledge_alias_lower ON knowledge_node_aliases(LOWER(alias));
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_from ON knowledge_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_to ON knowledge_edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_type ON knowledge_edges(relationship_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_edge ON knowledge_edge_assertions(edge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_citations_source ON knowledge_citations(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_citations_node ON knowledge_citations(node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_assessments_lens ON knowledge_assessments(lens);
CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_revision ON knowledge_reviews(target_revision_id);

INSERT INTO knowledge_schema_meta(singleton, schema_version, applied_at)
VALUES (1, ${KNOWLEDGE_SCHEMA_VERSION}, NOW())
ON CONFLICT(singleton) DO UPDATE SET
  schema_version = EXCLUDED.schema_version,
  applied_at = NOW();
`;
