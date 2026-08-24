export const KNOWLEDGE_SCHEMA_VERSION = 3;

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
  published_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE knowledge_nodes ADD COLUMN IF NOT EXISTS published_revision_id TEXT;

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
  published_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_node_id <> to_node_id)
);
ALTER TABLE knowledge_edges ADD COLUMN IF NOT EXISTS published_revision_id TEXT;

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
  published_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS published_revision_id TEXT;

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
  content_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE knowledge_edge_assertions ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE TABLE IF NOT EXISTS knowledge_citations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  node_revision_id TEXT,
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
ALTER TABLE knowledge_citations ADD COLUMN IF NOT EXISTS node_revision_id TEXT;

CREATE TABLE IF NOT EXISTS knowledge_assessments (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  node_revision_id TEXT,
  lens TEXT NOT NULL,
  position TEXT NOT NULL,
  rationale_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_state TEXT NOT NULL DEFAULT 'awaiting_review',
  content_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE knowledge_assessments ADD COLUMN IF NOT EXISTS node_revision_id TEXT;
ALTER TABLE knowledge_assessments ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE knowledge_assessments DROP CONSTRAINT IF EXISTS knowledge_assessments_node_id_lens_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_assessment_revision_lens
  ON knowledge_assessments(node_id, node_revision_id, lens);

CREATE TABLE IF NOT EXISTS knowledge_claim_family_members (
  family_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  claim_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'member',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (family_node_id, claim_node_id)
);

CREATE TABLE IF NOT EXISTS knowledge_topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  root_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  summary TEXT,
  content_state TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT,
  published_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_topic_versions (
  revision_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES knowledge_topics(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(topic_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_topic_nodes (
  topic_id TEXT NOT NULL REFERENCES knowledge_topics(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'featured',
  position INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(topic_id, node_id, role)
);

CREATE TABLE IF NOT EXISTS knowledge_paths (
  id TEXT PRIMARY KEY,
  topic_id TEXT REFERENCES knowledge_topics(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  path_type TEXT NOT NULL DEFAULT 'guided',
  description TEXT,
  content_state TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT,
  published_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_path_versions (
  revision_id TEXT PRIMARY KEY,
  path_id TEXT NOT NULL REFERENCES knowledge_paths(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(path_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_path_nodes (
  path_id TEXT NOT NULL REFERENCES knowledge_paths(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  position INTEGER NOT NULL,
  step_role TEXT NOT NULL DEFAULT 'step',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(path_id, position),
  UNIQUE(path_id, node_id, position)
);

CREATE TABLE IF NOT EXISTS knowledge_arguments (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  argument_type TEXT NOT NULL,
  conclusion_node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  content_state TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT,
  published_revision_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_argument_versions (
  revision_id TEXT PRIMARY KEY,
  argument_id TEXT NOT NULL REFERENCES knowledge_arguments(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(argument_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_argument_members (
  argument_id TEXT NOT NULL REFERENCES knowledge_arguments(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES knowledge_nodes(id),
  role TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(argument_id, node_id, role)
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
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_published_revision ON knowledge_nodes(published_revision_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_title_lower ON knowledge_nodes(LOWER(title));
CREATE INDEX IF NOT EXISTS idx_knowledge_alias_lower ON knowledge_node_aliases(LOWER(alias));
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_from ON knowledge_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_to ON knowledge_edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_type ON knowledge_edges(relationship_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_edges_published_revision ON knowledge_edges(published_revision_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_edge ON knowledge_edge_assertions(edge_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_revision ON knowledge_edge_assertions(revision_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_citations_source ON knowledge_citations(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_citations_node ON knowledge_citations(node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_citations_node_revision ON knowledge_citations(node_revision_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_assessments_lens ON knowledge_assessments(lens);
CREATE INDEX IF NOT EXISTS idx_knowledge_assessments_revision ON knowledge_assessments(node_revision_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_topics_root ON knowledge_topics(root_node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_topics_state ON knowledge_topics(content_state);
CREATE INDEX IF NOT EXISTS idx_knowledge_topic_nodes_topic ON knowledge_topic_nodes(topic_id, position);
CREATE INDEX IF NOT EXISTS idx_knowledge_paths_topic ON knowledge_paths(topic_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_paths_state ON knowledge_paths(content_state);
CREATE INDEX IF NOT EXISTS idx_knowledge_path_nodes_path ON knowledge_path_nodes(path_id, position);
CREATE INDEX IF NOT EXISTS idx_knowledge_arguments_conclusion ON knowledge_arguments(conclusion_node_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_arguments_state ON knowledge_arguments(content_state);
CREATE INDEX IF NOT EXISTS idx_knowledge_argument_members_argument ON knowledge_argument_members(argument_id, role, position);
CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_revision ON knowledge_reviews(target_revision_id);

INSERT INTO knowledge_schema_meta(singleton, schema_version, applied_at)
VALUES (1, ${KNOWLEDGE_SCHEMA_VERSION}, NOW())
ON CONFLICT(singleton) DO UPDATE SET
  schema_version = EXCLUDED.schema_version,
  applied_at = NOW();
`;
