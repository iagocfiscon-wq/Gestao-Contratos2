import argon2 from 'argon2';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL é obrigatória para o seed.');
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword || adminPassword.length < 12) throw new Error('ADMIN_PASSWORD deve ser definida e ter pelo menos 12 caracteres; ela nunca fica no código.');

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`INSERT INTO roles (key, name, description) VALUES
    ('ADMINISTRADOR','Administrador','Acesso total e configuração'),
    ('OPERACIONAL','Usuário operacional','Opera contratos e relatórios'),
    ('LEITURA','Somente leitura','Consulta e análise sem mutações'),
    ('VISITANTE','Visitante','Consulta pública controlada')
    ON CONFLICT (key) DO UPDATE SET name=excluded.name, description=excluded.description`);

  const adminUsername = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
  const adminName = process.env.ADMIN_NAME ?? 'Administrador do sistema';
  const hash = await argon2.hash(adminPassword, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await client.query('INSERT INTO users (name, username, email, password_hash, role_key) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO UPDATE SET name=excluded.name, password_hash=excluded.password_hash, role_key=excluded.role_key, active=true, updated_at=now()', [adminName, adminUsername, process.env.ADMIN_EMAIL ?? null, hash, 'ADMINISTRADOR']);
  await client.query('INSERT INTO users (name, username, role_key, password_hash) VALUES ($1,$2,$3,NULL) ON CONFLICT (username) DO UPDATE SET active=true, role_key=excluded.role_key', ['Visitante', 'visitante', 'VISITANTE']);
  await client.query(`INSERT INTO quality_rules (code, label, severity) VALUES
    ('SEM_CNPJ','Contratos sem CNPJ','warning'),
    ('SEM_CONTRATADO','Contratos sem contratado','warning'),
    ('SEM_FISCAL','Contratos sem fiscal','critical'),
    ('SEM_VIGENCIA','Contratos sem vigência','critical')
    ON CONFLICT (code) DO NOTHING`);
  await client.query(`INSERT INTO document_templates (type, version, content, active) VALUES ('despacho_renovacao', 1, 'Modelo institucional versionado; revisar antes do envio.', true) ON CONFLICT (type, version) DO NOTHING`);

  if (process.env.SEED_DEMO === 'true') {
    const company = await client.query(`INSERT INTO companies (cnpj, legal_name, trade_name) VALUES ('00000000000191','Empresa Sintética de Serviços Ltda.','Empresa Sintética') ON CONFLICT (cnpj) DO UPDATE SET legal_name=excluded.legal_name RETURNING id`);
    const director = await client.query(`INSERT INTO directors (name, directorate) VALUES ('Diretoria de Exemplo','Diretoria Administrativa') RETURNING id`);
    const existing = await client.query(`SELECT count(*)::int AS count FROM contracts WHERE legacy_row_id LIKE 'DEMO-%'`);
    if (existing.rows[0].count === 0) {
      const samples = [
        ['DEMO-001','CT-001','2026','Serviços contínuos de apoio','Serviços','250000.00','Vigente','2026-01-15','2026-11-30','Diretoria Administrativa'],
        ['DEMO-002','CT-002','2025','Manutenção predial preventiva','Obras','180000.00','Vigente','2025-04-01','2026-05-20','Diretoria Administrativa'],
        ['DEMO-003','CT-003','2024','Consultoria técnica de engenharia','Serviços de Engenharia','95000.00','Encerrado','2024-02-01','2025-12-31','Diretoria Administrativa'],
        ['DEMO-004','CT-004','2026','Licenciamento de software de gestão','Tecnologia','72000.00','Vigente','2026-02-10','2027-02-09','Diretoria Administrativa']
      ];
      for (const [legacy, number, year, description, objectType, value, status, start, end, directorate] of samples) {
        const contract = await client.query(`INSERT INTO contracts (legacy_row_id, contract_number, contract_year, company_id, contractor_name, contractor_document, description, object_type, original_value, current_value, start_date, end_date, status, directorate) VALUES ($1,$2,$3,$4,'Empresa Sintética de Serviços Ltda.','00000000000191',$5,$6,$7,$7,$8,$9,$10,$11) RETURNING id`, [legacy, number, Number(year), company.rows[0].id, description, objectType, Number(value), start, end, status, directorate]);
        await client.query(`INSERT INTO contract_assignments (contract_id, assignment_type, display_name, order_index) VALUES ($1,'fiscal','Fiscal de Exemplo',0),($1,'gestor','Gestor de Exemplo',0)`, [contract.rows[0].id]);
        await client.query('INSERT INTO contract_versions (contract_id, version, snapshot) SELECT id, version, to_jsonb(contracts) FROM contracts WHERE id=$1', [contract.rows[0].id]);
      }
      console.log(`Seed demo criado; diretor cadastrado: ${director.rows[0].id}`);
    }
  }
  await client.query('COMMIT');
  console.log('Seed aplicado.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
