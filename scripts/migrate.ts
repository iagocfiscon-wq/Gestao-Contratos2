import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL é obrigatória. Copie .env.example para .env e configure o PostgreSQL.');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const schema = await fs.readFile(path.resolve('db/schema.sql'), 'utf8');
  await client.query(schema);
  console.log('Migração aplicada com sucesso.');
} finally {
  await client.end();
}
