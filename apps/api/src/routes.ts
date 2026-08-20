import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query, withTransaction } from './db.js';
import { createVisitor, currentUserFromRequest, login, logout, requireUser } from './auth.js';
import { isValidCnpj, normalizeDocument, parseBrazilianNumber, type ContractFilters } from '../../../packages/shared/src/index.js';

function body(request: FastifyRequest): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}
function params(request: FastifyRequest): Record<string, string> {
  return (request.params ?? {}) as Record<string, string>;
}
function filters(request: FastifyRequest): ContractFilters {
  const q = (request.query ?? {}) as Record<string, string | undefined>;
  return {
    search: q.search?.trim() || undefined,
    year: q.year ? Number(q.year) : undefined,
    status: q.status || undefined,
    directorate: q.directorate || undefined,
    fiscal: q.fiscal || undefined,
    dueWithin: q.dueWithin ? Number(q.dueWithin) : undefined,
    includeDeleted: q.includeDeleted === 'true',
    page: Math.max(1, Number(q.page ?? 1)),
    pageSize: Math.min(100, Math.max(1, Number(q.pageSize ?? 25)))
  };
}
function clean(value: unknown): string | null { return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim(); }
function intValue(value: unknown): number | null { const n = Number(value); return Number.isInteger(n) ? n : null; }
function dateValue(value: unknown): string | null { const text = clean(value); return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null; }
function contractPayload(input: Record<string, unknown>) {
  const document = clean(input.contractor_document ?? input.cnpj);
  if (document && document.length !== 11 && document.length !== 14) throw Object.assign(new Error('CPF/CNPJ deve conter 11 ou 14 dígitos.'), { statusCode: 400, code: 'DOCUMENT_INVALID' });
  if (document?.length === 14 && !isValidCnpj(document)) throw Object.assign(new Error('CNPJ informado é inválido.'), { statusCode: 400, code: 'CNPJ_INVALIDO' });
  const start = dateValue(input.start_date ?? input.startDate);
  const end = dateValue(input.end_date ?? input.endDate);
  if (start && end && end < start) throw Object.assign(new Error('Final da vigência anterior ao início.'), { statusCode: 400, code: 'VIGENCIA_INVERTIDA' });
  return {
    instrument: clean(input.instrument),
    contract_number: clean(input.contract_number ?? input.contractNumber),
    contract_year: intValue(input.contract_year ?? input.contractYear),
    contractor_name: clean(input.contractor_name ?? input.contractorName),
    contractor_document: document ? normalizeDocument(document) : null,
    process_number: clean(input.process_number ?? input.processNumber),
    process_year: intValue(input.process_year ?? input.processYear),
    description: clean(input.description),
    object_type: clean(input.object_type ?? input.objectType),
    original_value: parseBrazilianNumber(input.original_value ?? input.originalValue),
    current_value: parseBrazilianNumber(input.current_value ?? input.currentValue),
    signature_date: dateValue(input.signature_date ?? input.signatureDate),
    start_date: start,
    end_date: end,
    status: clean(input.status) ?? 'Vigente',
    term_text: clean(input.term_text ?? input.termText),
    maximum_term_text: clean(input.maximum_term_text ?? input.maximumTermText),
    extension_text: clean(input.extension_text ?? input.extensionText),
    law: clean(input.law),
    notes: clean(input.notes),
    lot: clean(input.lot),
    directorate: clean(input.directorate),
    dispatch_status: clean(input.dispatch_status ?? input.dispatchStatus) ?? 'Despacho Pendente'
  };
}
function whereForContracts(f: ContractFilters, offset: number) {
  const values: unknown[] = [];
  const conditions = f.includeDeleted ? ['1=1'] : ['c.deleted_at IS NULL'];
  if (f.search) { values.push(`%${f.search.toLowerCase()}%`); conditions.push(`lower(coalesce(c.contract_number,'') || ' ' || coalesce(c.contractor_name,'') || ' ' || coalesce(c.contractor_document,'') || ' ' || coalesce(c.description,'')) LIKE $${values.length}`); }
  if (f.year) { values.push(f.year); conditions.push(`c.contract_year = $${values.length}`); }
  if (f.status) { values.push(f.status); conditions.push(`c.status = $${values.length}`); }
  if (f.directorate) { values.push(f.directorate); conditions.push(`c.directorate = $${values.length}`); }
  if (f.fiscal) { values.push(`%${f.fiscal.toLowerCase()}%`); conditions.push(`EXISTS (SELECT 1 FROM contract_assignments a WHERE a.contract_id=c.id AND a.assignment_type='fiscal' AND lower(a.display_name) LIKE $${values.length})`); }
  if (f.dueWithin !== undefined && Number.isFinite(f.dueWithin)) { values.push(f.dueWithin); conditions.push(`c.end_date BETWEEN current_date AND current_date + ($${values.length}::int)`); }
  return { where: conditions.join(' AND '), values, offset };
}
async function audit(user: Awaited<ReturnType<typeof currentUserFromRequest>>, action: string, entity: string, entityId: string | null, before?: unknown, after?: unknown, details?: string) {
  if (!user) return;
  await query('INSERT INTO audit_events (actor_id, actor_username, role_key, action, entity, entity_id, before_json, after_json, result, origin, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [user.id, user.username, user.role_key, action, entity, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, 'success', 'api', details ?? null]);
}
async function contractById(id: string) {
  const result = await query('SELECT c.*, COALESCE(json_agg(a ORDER BY a.order_index) FILTER (WHERE a.id IS NOT NULL), \'[]\') AS assignments FROM contracts c LEFT JOIN contract_assignments a ON a.contract_id=c.id AND a.active=true WHERE c.id=$1 GROUP BY c.id', [id]);
  return result.rows[0] as Record<string, unknown> | undefined;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'cfiscon-api', timestamp: new Date().toISOString() }));

  app.post('/auth/login', async (request, reply) => {
    const input = body(request);
    const username = String(input.username ?? '');
    const password = String(input.password ?? '');
    if (!username || !password) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Usuário e senha são obrigatórios.' } });
    const user = await login(username, password, request, reply);
    if (!user) return reply.code(401).send({ error: { code: 'AUTH_INVALID', message: 'Credenciais inválidas ou acesso temporariamente bloqueado.' } });
    return { data: user };
  });
  app.post('/auth/visitor', async (request, reply) => {
    const user = await createVisitor(request, reply);
    if (!user) return reply.code(503).send({ error: { code: 'VISITOR_UNAVAILABLE', message: 'Modo visitante não foi provisionado.' } });
    return { data: user };
  });
  app.get('/auth/me', async (request, reply) => {
    const user = await currentUserFromRequest(request);
    if (!user) return reply.code(401).send({ error: { code: 'AUTH_REQUIRED', message: 'Sessão necessária.' } });
    return { data: user };
  });
  app.post('/auth/logout', async (request, reply) => { await logout(request, reply); return { data: { ok: true } }; });

  app.get('/contracts', async (request, reply) => {
    const user = await requireUser(request, reply, 'read'); if (!user) return;
    const f = filters(request); const page = f.page ?? 1; const pageSize = f.pageSize ?? 25; const offset = (page - 1) * pageSize; const w = whereForContracts(f, offset);
    const count = await query<{ total: string; total_value: string }>(`SELECT count(*)::text AS total, coalesce(sum(coalesce(c.current_value,c.original_value)),0)::text AS total_value FROM contracts c WHERE ${w.where}`, w.values);
    const rows = await query(`SELECT c.id, c.legacy_row_id, c.instrument, c.contract_number, c.contract_year, c.contractor_name, c.contractor_document, c.description, c.object_type, c.original_value, c.current_value, c.signature_date, c.start_date, c.end_date, c.status, c.lot, c.directorate, c.dispatch_status, c.version, c.updated_at, COALESCE((SELECT string_agg(a.display_name, ', ' ORDER BY a.order_index) FROM contract_assignments a WHERE a.contract_id=c.id AND a.assignment_type='fiscal' AND a.active=true),'') AS fiscal FROM contracts c WHERE ${w.where} ORDER BY c.end_date NULLS LAST, c.contract_number LIMIT $${w.values.length + 1} OFFSET $${w.values.length + 2}`, [...w.values, pageSize, offset]);
    return { data: rows.rows, meta: { page, pageSize, total: Number(count.rows[0]?.total ?? 0), totalValue: Number(count.rows[0]?.total_value ?? 0) } };
  });

  app.get('/contracts/:id', async (request, reply) => {
    const user = await requireUser(request, reply, 'read'); if (!user) return;
    const contract = await contractById(params(request).id);
    if (!contract) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contrato não encontrado.' } });
    return { data: contract };
  });

  app.post('/contracts', async (request, reply) => {
    const user = await requireUser(request, reply, 'create'); if (!user) return;
    try {
      const input = contractPayload(body(request));
      if (!input.contract_number) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Número do contrato é obrigatório.' } });
      const created = await withTransaction(async (client) => {
        const result = await client.query('INSERT INTO contracts (instrument, contract_number, contract_year, contractor_name, contractor_document, process_number, process_year, description, object_type, original_value, current_value, signature_date, start_date, end_date, status, term_text, maximum_term_text, extension_text, law, notes, lot, directorate, dispatch_status, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24) RETURNING *', [input.instrument, input.contract_number, input.contract_year, input.contractor_name, input.contractor_document, input.process_number, input.process_year, input.description, input.object_type, input.original_value, input.current_value, input.signature_date, input.start_date, input.end_date, input.status, input.term_text, input.maximum_term_text, input.extension_text, input.law, input.notes, input.lot, input.directorate, input.dispatch_status, user.id]);
        await client.query('INSERT INTO contract_versions (contract_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4)', [result.rows[0].id, 1, JSON.stringify(result.rows[0]), user.id]);
        return result.rows[0];
      });
      await audit(user, 'CONTRATO_CRIADO', 'Contrato', created.id, undefined, created);
      return reply.code(201).send({ data: await contractById(created.id) });
    } catch (error) { const e = error as { code?: string; statusCode?: number; message?: string }; return reply.code(e.statusCode ?? 400).send({ error: { code: e.code ?? 'CREATE_FAILED', message: e.message ?? 'Não foi possível criar o contrato.' } }); }
  });

  app.patch('/contracts/:id', async (request, reply) => {
    const user = await requireUser(request, reply, 'update'); if (!user) return;
    const id = params(request).id; const current = await contractById(id); if (!current) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contrato não encontrado.' } });
    const input = body(request); const expectedVersion = Number(input.version ?? current.version); if (expectedVersion !== Number(current.version)) return reply.code(409).send({ error: { code: 'CONFLICT', message: 'Este contrato foi alterado por outro usuário. Atualize a tela antes de salvar.' }, data: current });
    try {
      const payload = contractPayload({ ...current, ...input });
      const result = await withTransaction(async (client) => {
        const updated = await client.query('UPDATE contracts SET instrument=$1, contract_number=$2, contract_year=$3, contractor_name=$4, contractor_document=$5, process_number=$6, process_year=$7, description=$8, object_type=$9, original_value=$10, current_value=$11, signature_date=$12, start_date=$13, end_date=$14, status=$15, term_text=$16, maximum_term_text=$17, extension_text=$18, law=$19, notes=$20, lot=$21, directorate=$22, dispatch_status=$23, version=version+1, updated_by=$24, updated_at=now() WHERE id=$25 AND version=$26 RETURNING *', [payload.instrument, payload.contract_number, payload.contract_year, payload.contractor_name, payload.contractor_document, payload.process_number, payload.process_year, payload.description, payload.object_type, payload.original_value, payload.current_value, payload.signature_date, payload.start_date, payload.end_date, payload.status, payload.term_text, payload.maximum_term_text, payload.extension_text, payload.law, payload.notes, payload.lot, payload.directorate, payload.dispatch_status, user.id, id, expectedVersion]);
        if (!updated.rows[0]) throw Object.assign(new Error('Conflito de versão.'), { statusCode: 409, code: 'CONFLICT' });
        await client.query('INSERT INTO contract_versions (contract_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4)', [id, updated.rows[0].version, JSON.stringify(updated.rows[0]), user.id]);
        return updated.rows[0];
      });
      await audit(user, 'CONTRATO_ATUALIZADO', 'Contrato', id, current, result);
      return { data: await contractById(id) };
    } catch (error) { const e = error as { code?: string; statusCode?: number; message?: string }; return reply.code(e.statusCode ?? 400).send({ error: { code: e.code ?? 'UPDATE_FAILED', message: e.message ?? 'Não foi possível atualizar o contrato.' } }); }
  });

  app.delete('/contracts/:id', async (request, reply) => {
    const user = await requireUser(request, reply, 'delete'); if (!user) return;
    const id = params(request).id; const current = await contractById(id); if (!current) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contrato não encontrado.' } });
    await query('UPDATE contracts SET deleted_at=now(), deleted_by=$1, deletion_reason=$2, version=version+1, updated_by=$1, updated_at=now() WHERE id=$3 AND deleted_at IS NULL', [user.id, String(body(request).reason ?? 'Exclusão reversível'), id]);
    await audit(user, 'CONTRATO_EXCLUIDO', 'Contrato', id, current, undefined, String(body(request).reason ?? 'Exclusão reversível'));
    return { data: { id, deleted: true } };
  });

  app.post('/contracts/:id/restore', async (request, reply) => {
    const user = await requireUser(request, reply, 'restore'); if (!user) return;
    const id = params(request).id; const result = await query('UPDATE contracts SET deleted_at=null, deleted_by=null, deletion_reason=null, version=version+1, updated_by=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NOT NULL RETURNING *', [user.id, id]);
    if (!result.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contrato removido não encontrado.' } });
    await audit(user, 'CONTRATO_RESTAURADO', 'Contrato', id, undefined, result.rows[0]);
    return { data: await contractById(id) };
  });

  app.get('/dashboard/summary', async (request, reply) => {
    const user = await requireUser(request, reply, 'read'); if (!user) return;
    const r = await query<{ total: string; active: string; risk: string; expired: string; total_value: string; average_value: string }>(`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::text AS total, count(*) FILTER (WHERE deleted_at IS NULL AND NOT lower(status) ~ '(encerrado|concluido|anulado|rescindido)')::text AS active, count(*) FILTER (WHERE deleted_at IS NULL AND end_date BETWEEN current_date AND current_date + 60)::text AS risk, count(*) FILTER (WHERE deleted_at IS NULL AND end_date < current_date AND NOT lower(status) ~ '(encerrado|concluido|anulado|rescindido)')::text AS expired, coalesce(sum(current_value) FILTER (WHERE deleted_at IS NULL),0)::text AS total_value, coalesce(avg(current_value) FILTER (WHERE deleted_at IS NULL),0)::text AS average_value FROM contracts`);
    const row = r.rows[0]; const status = await query('SELECT status, count(*)::int AS count, coalesce(sum(current_value),0)::numeric AS value FROM contracts WHERE deleted_at IS NULL GROUP BY status ORDER BY count DESC');
    return { data: { ...row, total: Number(row.total), active: Number(row.active), risk: Number(row.risk), expired: Number(row.expired), total_value: Number(row.total_value), average_value: Number(row.average_value), byStatus: status.rows, generatedAt: new Date().toISOString() } };
  });
  app.get('/dashboard/charts', async (request, reply) => {
    const user = await requireUser(request, reply, 'report'); if (!user) return;
    const byYear = await query('SELECT contract_year AS year, count(*)::int AS count, coalesce(sum(current_value),0)::numeric AS value FROM contracts WHERE deleted_at IS NULL GROUP BY contract_year ORDER BY contract_year');
    const byObject = await query('SELECT coalesce(object_type,\'Não informado\') AS object_type, count(*)::int AS count, coalesce(sum(current_value),0)::numeric AS value FROM contracts WHERE deleted_at IS NULL GROUP BY object_type ORDER BY value DESC');
    return { data: { byYear: byYear.rows, byObject: byObject.rows, generatedAt: new Date().toISOString() } };
  });
  app.get('/timeline', async (request, reply) => {
    const user = await requireUser(request, reply, 'read'); if (!user) return;
    const result = await query(`SELECT to_char(date_trunc('month', end_date), 'YYYY-MM') AS month, count(*)::int AS count, json_agg(json_build_object('id',id,'number',contract_number,'contractor',contractor_name,'endDate',end_date,'status',status) ORDER BY end_date) AS contracts FROM contracts WHERE deleted_at IS NULL AND end_date IS NOT NULL AND NOT lower(status) ~ '(encerrado|concluido|anulado|rescindido)' GROUP BY date_trunc('month', end_date) ORDER BY month`);
    return { data: result.rows };
  });
  app.get('/pendencias', async (request, reply) => {
    const user = await requireUser(request, reply, 'quality'); if (!user) return;
    const result = await query(`SELECT c.id, c.contract_number, c.contractor_name, c.end_date, c.status, c.dispatch_status, CASE WHEN c.end_date < current_date THEN 'critical' WHEN c.end_date <= current_date + 60 THEN 'urgent' WHEN c.contractor_document IS NULL OR c.contractor_name IS NULL THEN 'attention' ELSE 'info' END AS severity, array_remove(ARRAY[CASE WHEN c.end_date < current_date THEN 'Contrato vencido' END, CASE WHEN c.end_date BETWEEN current_date AND current_date + 60 THEN 'Vencimento próximo' END, CASE WHEN c.contractor_document IS NULL THEN 'Sem CNPJ' END, CASE WHEN c.contractor_name IS NULL THEN 'Sem contratado' END, CASE WHEN NOT EXISTS (SELECT 1 FROM contract_assignments a WHERE a.contract_id=c.id AND a.assignment_type='fiscal' AND a.active) THEN 'Sem fiscal' END, CASE WHEN c.start_date IS NULL OR c.end_date IS NULL THEN 'Vigência incompleta' END, CASE WHEN c.dispatch_status <> 'Despacho Enviado' AND c.end_date <= current_date + 180 THEN 'Despacho pendente' END], NULL) AS reasons FROM contracts c WHERE c.deleted_at IS NULL AND (c.end_date <= current_date + 180 OR c.contractor_document IS NULL OR c.contractor_name IS NULL OR c.start_date IS NULL OR c.end_date IS NULL OR c.dispatch_status <> 'Despacho Enviado') ORDER BY c.end_date NULLS FIRST LIMIT 500`);
    return { data: result.rows };
  });

  app.get('/quality/summary', async (request, reply) => {
    const user = await requireUser(request, reply, 'quality'); if (!user) return;
    const total = await query<{ total: string }>('SELECT count(*)::text AS total FROM contracts WHERE deleted_at IS NULL');
    const definitions = [
      ['SEM_CNPJ', 'Contratos sem CNPJ', `contractor_document IS NULL OR contractor_document=''`],
      ['SEM_CONTRATADO', 'Contratos sem contratado', `contractor_name IS NULL OR contractor_name=''`],
      ['SEM_FISCAL', 'Contratos sem fiscal', `NOT EXISTS (SELECT 1 FROM contract_assignments a WHERE a.contract_id=contracts.id AND a.assignment_type='fiscal' AND a.active)`],
      ['SEM_VIGENCIA', 'Contratos sem vigência', `start_date IS NULL OR end_date IS NULL`]
    ];
    const indicators = [];
    for (const [code, label, condition] of definitions) { const r = await query<{ count: string }>(`SELECT count(*)::text AS count FROM contracts WHERE deleted_at IS NULL AND ${condition}`); indicators.push({ code, label, count: Number(r.rows[0]?.count ?? 0), severity: code === 'SEM_FISCAL' ? 'critical' : 'warning' }); }
    const affected = indicators.reduce((sum, item) => sum + item.count, 0); const totalCount = Number(total.rows[0]?.total ?? 0);
    return { data: { total: totalCount, complete: Math.max(0, totalCount - affected), score: totalCount ? Math.max(0, Math.round((1 - affected / Math.max(totalCount * definitions.length, 1)) * 100)) : 100, indicators, checkedAt: new Date().toISOString() } };
  });
  app.get('/quality/findings', async (request, reply) => { const user = await requireUser(request, reply, 'quality'); if (!user) return; const result = await query(`SELECT c.id, c.contract_number, c.contractor_name, c.contractor_document, c.start_date, c.end_date, c.status FROM contracts c WHERE c.deleted_at IS NULL AND (c.contractor_document IS NULL OR c.contractor_name IS NULL OR c.start_date IS NULL OR c.end_date IS NULL OR NOT EXISTS (SELECT 1 FROM contract_assignments a WHERE a.contract_id=c.id AND a.assignment_type='fiscal' AND a.active)) ORDER BY c.updated_at DESC LIMIT 500`); return { data: result.rows }; });

  app.get('/duplicates', async (request, reply) => {
    const user = await requireUser(request, reply, 'compare'); if (!user) return;
    const result = await query(`SELECT lower(regexp_replace(coalesce(contract_number,''),'\\s','','g')) || '|' || coalesce(contract_year::text,'') || '|' || lower(regexp_replace(coalesce(contractor_name,''),'\\s','','g')) || '|' || coalesce(lot,'') AS duplicate_key, count(*)::int AS count, json_agg(json_build_object('id',id,'contractNumber',contract_number,'year',contract_year,'contractor',contractor_name,'lot',lot,'value',current_value,'status',status) ORDER BY updated_at) AS records FROM contracts WHERE deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1 ORDER BY count DESC`);
    return { data: result.rows };
  });

  app.get('/audit-events', async (request, reply) => {
    const user = await requireUser(request, reply, 'audit'); if (!user) return;
    const q = (request.query ?? {}) as Record<string, string | undefined>; const values: unknown[] = []; const conditions = ['1=1'];
    if (q.entityId) { values.push(q.entityId); conditions.push(`entity_id=$${values.length}`); } if (q.action) { values.push(q.action); conditions.push(`action=$${values.length}`); }
    values.push(Math.min(500, Math.max(1, Number(q.limit ?? 100))));
    const result = await query(`SELECT id, actor_username, role_key, action, entity, entity_id, field, before_json, after_json, result, origin, details, created_at FROM audit_events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return { data: result.rows };
  });

  app.get('/trash', async (request, reply) => { const user = await requireUser(request, reply, 'trash_read'); if (!user) return; const result = await query('SELECT * FROM contracts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 500'); return { data: result.rows }; });

  app.post('/contracts/:id/dispatch/preview', async (request, reply) => {
    const user = await requireUser(request, reply, 'read'); if (!user) return; const contract = await contractById(params(request).id); if (!contract) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contrato não encontrado.' } });
    const text = String(contract.dispatch_text ?? `DEPARTAMENTO MUNICIPAL DE ÁGUA E ESGOTOS\nCOORDENAÇÃO DE FISCALIZAÇÃO E GESTÃO DE CONTRATOS - GLIC/D-ADM/DMAE\nDESPACHO\n\nÀ área gestora e ao fiscal responsável,\n\nInformamos que o contrato nº ${contract.contract_number ?? 'não informado'}, firmado com ${contract.contractor_name ?? 'contratado não informado'}, possui término previsto para ${contract.end_date ?? 'data não informada'}.\n\nSolicita-se a análise quanto à necessidade de prorrogação, observando a legislação e os pareceres referenciais aplicáveis. Este texto é uma minuta e requer revisão institucional antes do envio.\n\nAtenciosamente,`);
    return { data: { contractId: contract.id, status: contract.dispatch_status, text, templateVersion: 1, requiresReview: true } };
  });
  app.post('/contracts/:id/dispatch/generate', async (request, reply) => { const user = await requireUser(request, reply, 'update'); if (!user) return; const id = params(request).id; const text = String(body(request).text ?? ''); if (!text.trim()) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Texto do despacho vazio.' } }); const result = await query('UPDATE contracts SET dispatch_text=$1, dispatch_status=\'Despacho Gerado\', dispatch_generated_at=now(), version=version+1, updated_by=$2, updated_at=now() WHERE id=$3 AND deleted_at IS NULL RETURNING *', [text, user.id, id]); if (!result.rows[0]) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Contrato não encontrado.' } }); await query('INSERT INTO generated_documents (contract_id, type, status, content, generated_by) VALUES ($1,$2,$3,$4,$5)', [id, 'despacho_renovacao', 'completed', text, user.id]); await audit(user, 'DESPACHO_GERADO', 'Contrato', id, undefined, { status: 'Despacho Gerado' }); return { data: { id, status: 'Despacho Gerado', generatedAt: result.rows[0].dispatch_generated_at } }; });
  app.post('/contracts/:id/dispatch/send', async (request, reply) => { const user = await requireUser(request, reply, 'update'); if (!user) return; const id = params(request).id; if (body(request).confirmation !== true) return reply.code(400).send({ error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirme explicitamente o envio após revisar a minuta.' } }); const result = await query('UPDATE contracts SET dispatch_status=\'Despacho Enviado\', dispatch_sent_at=now(), version=version+1, updated_by=$1, updated_at=now() WHERE id=$2 AND dispatch_status=\'Despacho Gerado\' AND deleted_at IS NULL RETURNING *', [user.id, id]); if (!result.rows[0]) return reply.code(409).send({ error: { code: 'DISPATCH_NOT_READY', message: 'Gere e revise o despacho antes de marcar o envio.' } }); await audit(user, 'DESPACHO_ENVIADO', 'Contrato', id, undefined, { status: 'Despacho Enviado', confirmation: true }); return { data: { id, status: 'Despacho Enviado', sentAt: result.rows[0].dispatch_sent_at } }; });

  app.post('/batch/update', async (request, reply) => { const user = await requireUser(request, reply, 'batch_update'); if (!user) return; const input = body(request); const ids = Array.isArray(input.ids) ? input.ids.map(String) : []; if (!ids.length || ids.length > 500) return reply.code(400).send({ error: { code: 'BATCH_LIMIT', message: 'Selecione entre 1 e 500 registros.' } }); const fields = (input.fields ?? {}) as Record<string, unknown>; const allowed = new Set(['status', 'directorate', 'object_type', 'dispatch_status', 'lot']); const entries = Object.entries(fields).filter(([key]) => allowed.has(key)); if (!entries.length) return reply.code(400).send({ error: { code: 'BATCH_FIELDS', message: 'Nenhum campo autorizado foi informado.' } }); const overwrite = input.mode === 'overwrite'; const results = []; for (const id of ids) { try { const current = await contractById(id); if (!current) { results.push({ id, status: 'not_found' }); continue; } const updates = entries.filter(([key]) => overwrite || current[key] === null || current[key] === '').map(([key]) => `${key}=$${entries.findIndex(([item]) => item === key) + 1}`); const values = entries.map(([, value]) => clean(value)); if (!updates.length) { results.push({ id, status: 'ignored' }); continue; } await query(`UPDATE contracts SET ${updates.join(',')}, version=version+1, updated_by=$${values.length + 1}, updated_at=now() WHERE id=$${values.length + 2}`, [...values, user.id, id]); results.push({ id, status: 'updated' }); } catch (error) { results.push({ id, status: 'failed', message: (error as Error).message }); } } await audit(user, 'OPERACAO_LOTE_ATUALIZAR', 'Contrato', null, undefined, { count: ids.length, results }); return { data: { results } }; });
  app.post('/batch/delete', async (request, reply) => { const user = await requireUser(request, reply, 'batch_delete'); if (!user) return; const input = body(request); const ids = Array.isArray(input.ids) ? input.ids.map(String) : []; if (!ids.length || ids.length > 500) return reply.code(400).send({ error: { code: 'BATCH_LIMIT', message: 'Selecione entre 1 e 500 registros.' } }); const results = []; for (const id of ids) { const r = await query('UPDATE contracts SET deleted_at=now(), deleted_by=$1, deletion_reason=$2, version=version+1, updated_by=$1, updated_at=now() WHERE id=$3 AND deleted_at IS NULL RETURNING id', [user.id, String(input.reason ?? 'Exclusão em lote'), id]); results.push({ id, status: r.rows[0] ? 'deleted' : 'not_found' }); } await audit(user, 'OPERACAO_LOTE_EXCLUIR', 'Contrato', null, undefined, { count: ids.length, results }); return { data: { results } }; });

  app.get('/companies', async (request, reply) => { const user = await requireUser(request, reply, 'read'); if (!user) return; const q = (request.query as Record<string, string | undefined> | undefined)?.search; const result = await query('SELECT * FROM companies WHERE ($1::text IS NULL OR lower(legal_name || \' \' || coalesce(trade_name,\'\') || \' \' || coalesce(cnpj,\'\')) LIKE lower(\'%\' || $1 || \'%\')) ORDER BY legal_name LIMIT 100', [q || null]); return { data: result.rows }; });
  app.get('/directors', async (request, reply) => { const user = await requireUser(request, reply, 'read'); if (!user) return; const result = await query('SELECT * FROM directors WHERE active=true ORDER BY directorate, name'); return { data: result.rows }; });
  app.post('/companies', async (request, reply) => { const user = await requireUser(request, reply, 'create'); if (!user) return; const input = body(request); const cnpj = normalizeDocument(input.cnpj); if (cnpj.length !== 14 || !isValidCnpj(cnpj)) return reply.code(400).send({ error: { code: 'CNPJ_INVALIDO', message: 'CNPJ informado é inválido.' } }); const result = await query('INSERT INTO companies (cnpj, legal_name, trade_name) VALUES ($1,$2,$3) RETURNING *', [cnpj, clean(input.legal_name) ?? '', clean(input.trade_name)]); await audit(user, 'EMPRESA_CRIADA', 'Company', result.rows[0].id, undefined, result.rows[0]); return reply.code(201).send({ data: result.rows[0] }); });
}
