import pg from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatória.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const tables = await client.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('users','sessions','contracts','contract_assignments','contract_versions','audit_events','import_batches','import_rows','quality_rules') ORDER BY tablename`);
  const missing = ['users','sessions','contracts','contract_assignments','contract_versions','audit_events','import_batches','import_rows','quality_rules'].filter((name) => !tables.rows.some((row) => row.tablename === name));
  const indexes = await client.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('contracts_active_end_idx','contracts_status_idx','contracts_year_idx','audit_entity_idx')`);
  const roles = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM roles');
  const payload = { ok: missing.length === 0, tables: tables.rows.map((row) => row.tablename), missing, indexes: indexes.rows.map((row) => row.indexname), roleCount: Number(roles.rows[0]?.count ?? 0) };
  console.log(JSON.stringify(payload, null, 2));
  if (!payload.ok) process.exitCode = 1;
} finally { await client.end(); }
