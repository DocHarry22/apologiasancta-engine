import pg from "pg";

const { Pool } = pg;
const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.SUPABASE_DATABASE_URL || process.env.DATABASE_URL;
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

async function copyTable(sourceClient, targetClient, table) {
  if (!(await tableExists(sourceClient, table))) return 0;
  if (!(await tableExists(targetClient, table))) throw new Error(`Target table missing: ${table}`);
  const rows = (await sourceClient.query(`select * from ${table}`)).rows;
  if (!rows.length) return 0;
  const columns = Object.keys(rows[0]);
  const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
  await targetClient.query(`delete from ${table}`);
  for (const row of rows) {
    const values = columns.map((column) => row[column]);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
    await targetClient.query(`insert into ${table} (${quoted}) values (${placeholders})`, values);
  }
  return rows.length;
}

try {
  await source.query("select 1");
  await target.query("select 1");
  await target.query("begin");
  const counts = {};
  for (const table of tables) counts[table] = await copyTable(source, target, table);
  await target.query("commit");
  console.log(JSON.stringify({ ok: true, counts }, null, 2));
} catch (error) {
  await target.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await Promise.all([source.end(), target.end()]);
}
