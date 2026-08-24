-- Apologia Sancta Knowledge Engine target schema.
-- This migration is intentionally idempotent so it can be applied to the
-- dedicated Supabase project without disturbing existing application tables.

create table if not exists knowledge_schema_meta (
  singleton smallint primary key default 1 check (singleton = 1),
  schema_version integer not null,
  applied_at timestamptz not null default now()
);

create table if not exists knowledge_nodes (
  id text primary key,
  kind text not null,
  canonical_slug text not null unique,
  title text not null,
  proposition text,
  summary text,
  language text,
  content_state text not null default 'draft',
  current_revision_id text,
  published_revision_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists knowledge_node_versions (
  revision_id text primary key,
  node_id text not null references knowledge_nodes(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  snapshot jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique(node_id, version)
);

create table if not exists knowledge_edges (
  id text primary key,
  from_node_id text not null references knowledge_nodes(id) on delete cascade,
  to_node_id text not null references knowledge_nodes(id) on delete cascade,
  relationship_type text not null,
  content_state text not null default 'draft',
  current_revision_id text,
  published_revision_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_node_id <> to_node_id)
);

create table if not exists knowledge_edge_versions (
  revision_id text primary key,
  edge_id text not null references knowledge_edges(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  snapshot jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique(edge_id, version)
);

create table if not exists knowledge_sources (
  id text primary key,
  source_type text not null,
  title text not null,
  author text,
  edition text,
  language text,
  authority_class text,
  binding_status text,
  licensing_status text not null default 'unknown',
  content_state text not null default 'draft',
  current_revision_id text,
  published_revision_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists knowledge_source_versions (
  revision_id text primary key,
  source_id text not null references knowledge_sources(id) on delete cascade,
  version integer not null,
  content_hash text not null,
  snapshot jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique(source_id, version)
);

create table if not exists knowledge_edge_assertions (
  id text primary key,
  edge_id text not null references knowledge_edges(id) on delete cascade,
  asserted_by_type text not null,
  asserted_by_id text not null,
  stance text not null,
  source_ids jsonb not null default '[]'::jsonb,
  attribution_mode text not null,
  confidence text not null default 'unresolved',
  review_state text not null default 'awaiting_review',
  revision_id text,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists knowledge_citations (
  id text primary key,
  source_id text not null references knowledge_sources(id) on delete cascade,
  node_id text references knowledge_nodes(id) on delete cascade,
  node_revision_id text,
  edge_assertion_id text references knowledge_edge_assertions(id) on delete cascade,
  locator text not null,
  fragment text,
  fragment_mode text not null default 'reference_only',
  attribution_mode text not null default 'source',
  content_hash text,
  review_state text not null default 'unverified',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (node_id is not null or edge_assertion_id is not null)
);

create table if not exists knowledge_assessments (
  id text primary key,
  node_id text not null references knowledge_nodes(id) on delete cascade,
  node_revision_id text,
  lens text not null,
  position text not null,
  rationale_ids jsonb not null default '[]'::jsonb,
  source_ids jsonb not null default '[]'::jsonb,
  review_state text not null default 'awaiting_review',
  content_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_knowledge_assessment_revision_lens
  on knowledge_assessments(node_id, node_revision_id, lens);

create index if not exists idx_knowledge_nodes_state on knowledge_nodes(content_state);
create index if not exists idx_knowledge_nodes_published_revision on knowledge_nodes(published_revision_id);
create index if not exists idx_knowledge_edges_from on knowledge_edges(from_node_id);
create index if not exists idx_knowledge_edges_to on knowledge_edges(to_node_id);
create index if not exists idx_knowledge_edges_published_revision on knowledge_edges(published_revision_id);
create index if not exists idx_knowledge_assertions_edge on knowledge_edge_assertions(edge_id);
create index if not exists idx_knowledge_assertions_revision on knowledge_edge_assertions(revision_id);
create index if not exists idx_knowledge_citations_source on knowledge_citations(source_id);
create index if not exists idx_knowledge_citations_node on knowledge_citations(node_id);
create index if not exists idx_knowledge_assessments_revision on knowledge_assessments(node_revision_id);

insert into knowledge_schema_meta(singleton, schema_version)
values (1, 3)
on conflict (singleton) do update set schema_version = excluded.schema_version, applied_at = now();

-- Publication provenance guard. Only an approved attributable assertion with
-- published source evidence and an approved citation may publish an edge.
create or replace function knowledge_assert_edge_publication_dependencies()
returns trigger
language plpgsql
as $$
declare assertion_count integer;
begin
  if new.published_revision_id is null
     or new.published_revision_id is not distinct from old.published_revision_id then
    return new;
  end if;

  if not exists (
    select 1 from knowledge_nodes n
    where n.id = new.from_node_id and n.published_revision_id is not null
  ) or not exists (
    select 1 from knowledge_nodes n
    where n.id = new.to_node_id and n.published_revision_id is not null
  ) then
    raise exception 'knowledge edge publication requires both endpoint nodes to be published';
  end if;

  select count(*) into assertion_count
  from knowledge_edge_assertions a
  where a.edge_id = new.id
    and a.revision_id = new.published_revision_id
    and a.review_state = 'approved'
    and jsonb_typeof(a.source_ids) = 'array'
    and jsonb_array_length(a.source_ids) > 0
    and not exists (
      select 1
      from jsonb_array_elements_text(a.source_ids) s(source_id)
      left join knowledge_sources src on src.id = s.source_id
      where src.published_revision_id is null
    )
    and exists (
      select 1
      from knowledge_citations c
      join knowledge_sources src on src.id = c.source_id
      where c.edge_assertion_id = a.id
        and c.review_state = 'approved'
        and src.published_revision_id is not null
    );

  if assertion_count < 1 then
    raise exception 'knowledge edge publication requires approved attributable source evidence';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_knowledge_edge_publication_dependencies on knowledge_edges;
create trigger trg_knowledge_edge_publication_dependencies
before update of published_revision_id on knowledge_edges
for each row execute function knowledge_assert_edge_publication_dependencies();
