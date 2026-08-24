import pg from "pg";

const { Pool } = pg;
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
const requireEmptyTarget = process.env.REQUIRE_EMPTY_TARGET !== "false";

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

async function tableExists(client, table) {
  const result = await client.query("select to_regclass($1) as name", [`public.${table}`]);
  return Boolean(result.rows[0]?.name);
}

async function countTable(client, table) {
  if (!(await tableExists(client, table))) return null;
  const result = await client.query(`select count(*)::bigint as count from ${table}`);
  return Number(result.rows[0].count);
}

async function copyTable(sourceClient, targetClient, table) {
  if (!(await tableExists(sourceClient, table))) return 0;
  if (!(await tableExists(targetClient, table))) throw new Error(`Target table missing: ${table}`);

  const rows = (await sourceClient.query(`select * from ${table}`)).rows;
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
    await targetClient.query(`insert into ${table} (${quoted}) values ${tuples}`, values);
  }

  return rows.length;
}

async function resetTargetSequence(client, table) {
  const columns = await client.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1 and column_default like 'nextval(%'`,
    [table],
  );
  for (const row of columns.rows) {
    const sequence = await client.query(`select pg_get_serial_sequence($1, $2) as sequence`, [table, row.column_name]);
    if (sequence.rows[0]?.sequence) {
      await client.query(`select setval($1, coalesce((select max("${row.column_name.replaceAll('"', '""')}") from ${table}), 1), true)`, [sequence.rows[0].sequence]);
    }
  }
}

try {
  await source.query("select 1");
  await target.query("select 1");

  const sourceCounts = {};
  const targetCounts = {};
  for (const table of tables) {
    sourceCounts[table] = await countTable(source, table);
    targetCounts[table] = await countTable(target, table);
  }

  const occupiedTarget = Object.entries(targetCounts).filter(([, count]) => count && count > 0);
  if (requireEmptyTarget && occupiedTarget.length) {
    throw new Error(`Refusing migration because target is not empty: ${JSON.stringify(Object.fromEntries(occupiedTarget))}`);
  }

  await target.query("begin");
  await target.query(`truncate table ${tables.map((table) => `"${table}"`).join(", ")} cascade`);

  const copied = {};
  for (const table of tables) {
    copied[table] = await copyTable(source, target, table);
    await resetTargetSequence(target, table);
  }

  await target.query("commit");
  console.log(JSON.stringify({ ok: true, sourceCounts, copied, targetWasEmpty: occupiedTarget.length === 0 }, null, 2));
} catch (error) {
  await target.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await Promise.all([source.end(), target.end()]);
}
