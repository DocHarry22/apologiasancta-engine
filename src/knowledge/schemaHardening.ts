export const KNOWLEDGE_SCHEMA_HARDENING_SQL = `
CREATE OR REPLACE FUNCTION knowledge_assert_edge_publication_dependencies()
RETURNS trigger AS $$
DECLARE
  source_published TEXT;
  target_published TEXT;
  assertion_count INTEGER;
BEGIN
  IF NEW.published_revision_id IS NULL OR NEW.published_revision_id IS NOT DISTINCT FROM OLD.published_revision_id THEN
    RETURN NEW;
  END IF;

  SELECT published_revision_id INTO source_published FROM knowledge_nodes WHERE id = NEW.from_node_id;
  SELECT published_revision_id INTO target_published FROM knowledge_nodes WHERE id = NEW.to_node_id;

  IF source_published IS NULL OR target_published IS NULL THEN
    RAISE EXCEPTION 'knowledge edge publication requires both endpoint nodes to be published';
  END IF;

  SELECT COUNT(*) INTO assertion_count
  FROM knowledge_edge_assertions a
  WHERE a.edge_id = NEW.id
    AND a.revision_id = NEW.published_revision_id
    AND a.review_state = 'approved'
    AND jsonb_typeof(a.source_ids) = 'array'
    AND jsonb_array_length(a.source_ids) > 0
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(a.source_ids) source_ref(source_id)
      LEFT JOIN knowledge_sources s ON s.id = source_ref.source_id
      WHERE s.published_revision_id IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM knowledge_citations c
      JOIN knowledge_sources s ON s.id = c.source_id
      WHERE c.edge_assertion_id = a.id
        AND c.review_state = 'approved'
        AND s.published_revision_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(a.source_ids) source_ref(source_id)
          WHERE source_ref.source_id = c.source_id
        )
    );

  IF assertion_count < 1 THEN
    RAISE EXCEPTION 'knowledge edge publication requires an approved attributable assertion with published source evidence and an approved citation for this revision';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_edge_publication_dependencies ON knowledge_edges;
CREATE TRIGGER trg_knowledge_edge_publication_dependencies
BEFORE UPDATE OF published_revision_id ON knowledge_edges
FOR EACH ROW EXECUTE FUNCTION knowledge_assert_edge_publication_dependencies();

CREATE OR REPLACE FUNCTION knowledge_assert_artifact_review_dimension()
RETURNS trigger AS $$
BEGIN
  IF NEW.target_type = 'citation' AND NEW.review_dimension NOT IN ('source', 'translation', 'licensing') THEN
    RAISE EXCEPTION 'citation reviews must use source, translation, or licensing dimensions';
  ELSIF NEW.target_type = 'edge_assertion' AND NEW.review_dimension NOT IN ('source', 'provenance', 'doctrinal', 'historical') THEN
    RAISE EXCEPTION 'edge assertion review dimension is incompatible';
  ELSIF NEW.target_type = 'assessment' AND NEW.review_dimension NOT IN ('doctrinal', 'historical', 'provenance') THEN
    RAISE EXCEPTION 'assessment review dimension is incompatible';
  ELSIF NEW.target_type = 'source' AND NEW.review_dimension NOT IN ('source', 'translation', 'historical', 'licensing') THEN
    RAISE EXCEPTION 'source review dimension is incompatible';
  ELSIF NEW.target_type = 'node' AND NEW.review_dimension NOT IN ('source', 'doctrinal', 'translation', 'historical', 'licensing', 'provenance') THEN
    RAISE EXCEPTION 'node review dimension is incompatible';
  ELSIF NEW.target_type = 'edge' AND NEW.review_dimension NOT IN ('source', 'doctrinal', 'historical', 'provenance') THEN
    RAISE EXCEPTION 'edge review dimension is incompatible';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_review_dimension ON knowledge_reviews;
CREATE TRIGGER trg_knowledge_review_dimension
BEFORE INSERT OR UPDATE ON knowledge_reviews
FOR EACH ROW EXECUTE FUNCTION knowledge_assert_artifact_review_dimension();

CREATE OR REPLACE FUNCTION knowledge_assert_citation_approval_dependencies()
RETURNS trigger AS $$
DECLARE
  source_published TEXT;
BEGIN
  IF NEW.review_state <> 'approved' OR NEW.review_state IS NOT DISTINCT FROM OLD.review_state THEN
    RETURN NEW;
  END IF;

  SELECT published_revision_id INTO source_published FROM knowledge_sources WHERE id = NEW.source_id;
  IF source_published IS NULL THEN
    RAISE EXCEPTION 'approved citation requires its source to be published';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_citation_approval_dependencies ON knowledge_citations;
CREATE TRIGGER trg_knowledge_citation_approval_dependencies
BEFORE UPDATE OF review_state ON knowledge_citations
FOR EACH ROW EXECUTE FUNCTION knowledge_assert_citation_approval_dependencies();
`;
