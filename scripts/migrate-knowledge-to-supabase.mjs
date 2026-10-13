import pg from "pg";

const { Pool } = pg;
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
const requireEmptyTarget = process.env.REQUIRE_EMPTY_TARGET !== "false";
const dryRun = process.env.DRY_RUN !== "false";

if (!sourceUrl) throw new Error("SOURCE_DATABASE_URL is required (Render PostgreSQL read connection string)");
if (!targetUrl) throw new Error("SUPABASE_DATABASE_URL is required (Supabase PostgreSQL connection string)");

const source = new Pool({ connectionString: sourceUrl, max: 2, ssl: { rejectUnauthorized: false } });
const target = new Pool({ connectionString: targetUrl, max: 2, ssl: { rejectUnauthorized: false } });

const tables = [
  "knowledge_schema_meta",
  "knowledge_nodes",
  "knowledge_node_aliases",
  "knowledge_node_versions",
  "knowledge_edges",
  "knowledge_edge_versions",
  "knowledge_sources",
  "knowledge_source_versions",
  "knowledge_edge_assertions",
  "knowledge_citations",
  "knowledge_assessments",
  "knowledge_claim_family_members",
  "knowledge_topics",
  "knowledge_topic_versions",
  "knowledge_topic_nodes",
  "knowledge_paths",
  "knowledge_path_versions",
  "knowledge_path_nodes",
  "knowledge_arguments",
  "knowledge_argument_versions",
  "knowledge_argument_members",
  "knowledge_reviews",
  "knowledge_publication_events",
  "knowledge_authoring_proposals",
  "knowledge_query_observations",
];

// The target's schema metadata is created by the Supabase schema migration.
// It is not migrated content and must never be truncated or copied over.
const contentTables = tables.filter((table) => table !== "knowledge_schema_meta");
async function tableExists(client, table) {
  const result = await client.query("select to_regclass($1) as name", [`public.${table}`]);
  return Boolean(result.rows[0]?.name);
}

async function countTable(client, table) {
  if (!(await tableExists(client, table))) return null;
  const result = await client.query(`select count(*)::bigint as count from public."${table}"`);
  return Number(result.rows[0].count);
}

async function copyTable(sourceClient, targetClient, table) {
  const rows = (await sourceClient.query(`select * from public."${table}"`)).rows;
  if (!rows.length) return 0;

  const columns = Object.keys(rows[0]);
  const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
  const batchSize = 200;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = [];
    const tuples = batch.map((row, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        values.push(row[column]);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      }).join(",");
      return `(${placeholders})`;
    }).join(",");
    await targetClient.query(`insert into public."${table}" (${quoted}) values ${tuples}`, values);
  }

  return rows.length;
}

async function resetTargetSequence(client, table) {
  const columns = await client.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name=$1 and column_default like 'nextval(%'",
    [table],
  );
  for (const row of columns.rows) {
    const sequence = await client.query("select pg_get_serial_sequence($1, $2) as sequence", [`public.${table}`, row.column_name]);
    if (sequence.rows[0]?.sequence) {
      const column = row.column_name.replaceAll('"', '""');
      await client.query(
        `select setval($1::regclass, greatest(coalesce((select max("${column}") from public."${table}"), 0), 1), true)`,
        [sequence.rows[0].sequence],
      );
    }
  }
}

let sourceClient;
let targetClient;
try {
  if (!requireEmptyTarget) throw new Error("REQUIRE_EMPTY_TARGET=false is unsafe and is not supported");
  if (sourceUrl === targetUrl) throw new Error("Source and target database URLs must be different");

  sourceClient = await source.connect();
  targetClient = await target.connect();
  // Keep a consistent source snapshot and use ONE target client for the entire transaction.
  await sourceClient.query("begin transaction isolation level repeatable read read only");
  await targetClient.query("begin");

  // During a real migration, prevent a concurrent writer from inserting records
  // between the empty-target check and the copy. Dry-run only reads.
  if (!dryRun) {
    await targetClient.query(`lock table ${contentTables.map((table) => `public."${table}"`).join(", ")} in share row exclusive mode`);
  }

  const sourceCounts = {};
  const targetCountsBefore = {};
  for (const table of tables) {
    sourceCounts[table] = await countTable(sourceClient, table);
    targetCountsBefore[table] = await countTable(targetClient, table);
  }

  const sourceMissing = tables.filter((table) => sourceCounts[table] === null);
  const targetMissing = tables.filter((table) => targetCountsBefore[table] === null);
  if (sourceMissing.length || targetMissing.length) {
    throw new Error(`Knowledge schema incomplete. Source missing: [${sourceMissing.join(", ")}]; target missing: [${targetMissing.join(", ")}]`);
  }

  const occupiedTarget = Object.fromEntries(
    contentTables.filter((table) => targetCountsBefore[table] !== 0).map((table) => [table, targetCountsBefore[table]]),
  );
  if (Object.keys(occupiedTarget).length) {
    throw new Error(`Refusing migration: destination Knowledge content is not empty: ${JSON.stringify(occupiedTarget)}`);
  }

  const sourceMeta = (await sourceClient.query("select schema_version from public.knowledge_schema_meta where singleton=1")).rows[0]?.schema_version;
  const targetMeta = (await targetClient.query("select schema_version from public.knowledge_schema_meta where singleton=1")).rows[0]?.schema_version;
  if (!sourceMeta || !targetMeta || Number(sourceMeta) > Number(targetMeta)) {
    throw new Error(`Knowledge schema version incompatible (source=${sourceMeta ?? "missing"}, target=${targetMeta ?? "missing"})`);
  }

  const sourceContentRows = contentTables.reduce((sum, table) => sum + sourceCounts[table], 0);
  if (sourceContentRows === 0) {
    throw new Error("Source Knowledge Engine contains zero content/history rows; refusing to report an empty migration as successful");
  }

  if (dryRun) {
    await targetClient.query("rollback");
    await sourceClient.query("commit");
    console.log(JSON.stringify({ ok: true, dryRun: true, sourceCounts, targetCountsBefore, sourceSchemaVersion: sourceMeta, targetSchemaVersion: targetMeta }, null, 2));
  } else {
    const copied = {};
    for (const table of contentTables) {
      copied[table] = await copyTable(sourceClient, targetClient, table);
      await resetTargetSequence(targetClient, table);
    }

    const mismatches = {};
    const verifiedCounts = {};
    for (const table of contentTables) {
      verifiedCounts[table] = await countTable(targetClient, table);
      if (verifiedCounts[table] !== sourceCounts[table] || copied[table] !== sourceCounts[table]) {
        mismatches[table] = { source: sourceCounts[table], copied: copied[table], target: verifiedCounts[table] };
      }
    }
    if (Object.keys(mismatches).length) throw new Error(`Migration reconciliation failed: ${JSON.stringify(mismatches)}`);

    await targetClient.query("commit");
    await sourceClient.query("commit");
    console.log(JSON.stringify({ ok: true, dryRun: false, sourceCounts, copied, verifiedCounts, targetSchemaVersion: targetMeta }, null, 2));
  }
} catch (error) {
  if (targetClient) await targetClient.query("rollback").catch(() => undefined);
  if (sourceClient) await sourceClient.query("rollback").catch(() => undefined);
  throw error;
} finally {
  sourceClient?.release();
  targetClient?.release();
  await Promise.all([source.end(), target.end()]);
}
