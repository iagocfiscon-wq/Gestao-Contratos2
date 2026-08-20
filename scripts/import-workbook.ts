import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { query, withTransaction } from '../apps/api/src/db.js';
import { normalizeDocument, normalizeText, parseBrazilianNumber, isValidCnpj } from '../packages/shared/src/index.js';

const workbookPath = process.env.WORKBOOK_PATH ?? process.argv[2];
const mode = process.env.IMPORT_MODE ?? process.argv.find((arg) => arg.startsWith('--mode='))?.split('=')[1] ?? 'analyze';
if (!workbookPath) throw new Error('Informe WORKBOOK_PATH ou passe o caminho do .xlsx como argumento.');
if (!fs.existsSync(workbookPath)) throw new Error(`Arquivo não encontrado: ${workbookPath}`);

const workbook = XLSX.readFile(workbookPath, { cellDates: true, cellFormula: true });
const sheetName = workbook.SheetNames.find((name) => normalizeText(name).includes('contrato')) ?? workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: false });
const fileHash = crypto.createHash('sha256').update(fs.readFileSync(workbookPath)).digest('hex');
const report = { file: path.basename(workbookPath), fileHash, sheetName, rows: rows.length, sheets: workbook.SheetNames, errors: [] as Array<{ row: number; code: string; message: string }>, unknownHeaders: [] as string[], duplicates: [] as string[] };
const known = new Set(['rowid','instrumento','n contrato','n° contrato','ano contrato','contratado','cpf/cnpj','descrição do objeto','valor contrato','valor com alterações','assinatura','início vigência','final vigência','situação','n° processo','ano processo','gestor(es)','natureza objeto','objeto','suplente(s)','fiscal(is)','prazo','prazo máximo vigência','prorrogação prazo','lei','obs:','data envio despacho','status despacho','data geração despacho','despacho renovação','lote','diretoria','atualizado por']);
const headers = rows[0] ? Object.keys(rows[0]) : [];
report.unknownHeaders = headers.filter((header) => !known.has(normalizeText(header)));
const seen = new Set<string>();
const normalizedRows = rows.map((row, index) => {
  const rowNumber = index + 2;
  const errors: Array<{ code: string; message: string }> = [];
  const get = (...names: string[]) => { const key = Object.keys(row).find((candidate) => names.some((name) => normalizeText(candidate) === normalizeText(name))); return key ? row[key] : null; };
  const legacyRowId = String(get('RowID') ?? rowNumber).trim();
  const contractNumber = String(get('N° Contrato', 'N Contrato') ?? '').trim();
  const contractYear = Number(String(get('Ano Contrato') ?? '').replace(/\D/g, '')) || null;
  const cnpjRaw = get('CPF/CNPJ');
  const document = normalizeDocument(cnpjRaw);
  const contractorName = String(get('Contratado') ?? '').trim() || null;
  if (document && document.length === 14 && !isValidCnpj(document)) errors.push({ code: 'CNPJ_INVALIDO', message: 'CNPJ não passou no dígito verificador.' });
  if (document && document.length !== 11 && document.length !== 14) errors.push({ code: 'DOCUMENTO_INVALIDO', message: 'Documento possui quantidade inesperada de dígitos.' });
  if (!contractNumber) errors.push({ code: 'SEM_NUMERO', message: 'Número do contrato ausente.' });
  const duplicateKey = `${normalizeText(contractNumber)}|${contractYear ?? ''}|${normalizeText(contractorName)}|${normalizeText(get('Lote'))}`;
  if (seen.has(duplicateKey) && contractNumber) report.duplicates.push(legacyRowId);
  seen.add(duplicateKey);
  const endDate = String(get('Final Vigência', 'Final Vigencia') ?? '').trim() || null;
  const startDate = String(get('Início Vigência', 'Inicio Vigencia') ?? '').trim() || null;
  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) errors.push({ code: 'VIGENCIA_INVERTIDA', message: 'Final da vigência anterior ao início.' });
  if (errors.length) for (const error of errors) report.errors.push({ row: rowNumber, ...error });
  return {
    rowNumber,
    legacyRowId,
    original: row,
    normalized: {
      legacy_row_id: legacyRowId,
      contract_number: contractNumber || null,
      contract_year: contractYear,
      contractor_name: contractorName,
      contractor_document: document || null,
      description: String(get('Descrição do Objeto', 'Descrição', 'Objeto') ?? '').trim() || null,
      object_type: String(get('Natureza Objeto', 'Objeto') ?? '').trim() || null,
      original_value: parseBrazilianNumber(get('Valor Contrato')),
      current_value: parseBrazilianNumber(get('Valor com Alterações')) ?? parseBrazilianNumber(get('Valor Contrato')),
      start_date: startDate,
      end_date: endDate,
      status: String(get('Situação') ?? 'Vigente').trim() || 'Vigente',
      lot: String(get('Lote') ?? '').trim() || null,
      directorate: String(get('Diretoria') ?? '').trim() || null,
      dispatch_status: String(get('Status Despacho') ?? 'Despacho Pendente').trim() || 'Despacho Pendente',
      dispatch_text: String(get('Despacho Renovação') ?? '').trim() || null,
      legacy_payload: row
    },
    errors
  };
});

const out = { ...report, validRows: normalizedRows.filter((row) => row.errors.length === 0).length, invalidRows: normalizedRows.filter((row) => row.errors.length > 0).length, duplicateRows: report.duplicates.length };
await fs.promises.mkdir(path.resolve('storage/imports'), { recursive: true });
await fs.promises.writeFile(path.resolve('storage/imports', `${fileHash}.json`), JSON.stringify({ report: out, rows: normalizedRows }, null, 2));
console.log(JSON.stringify(out, null, 2));

if (mode === 'analyze') process.exit(0);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatória nos modos stage/publish.');
if (mode === 'stage') {
  const batch = await query<{ id: string }>('INSERT INTO import_batches (filename, file_hash, status, summary) VALUES ($1,$2,$3,$4) ON CONFLICT (file_hash) DO UPDATE SET summary=excluded.summary, status=\'staged\', finished_at=null RETURNING id', [path.basename(workbookPath), fileHash, 'staged', JSON.stringify(out)]);
  const batchId = batch.rows[0].id;
  await withTransaction(async (client) => {
    await client.query('DELETE FROM import_rows WHERE batch_id=$1', [batchId]);
    for (const row of normalizedRows) await client.query('INSERT INTO import_rows (batch_id, row_number, legacy_row_id, payload_original, payload_normalized, status, errors) VALUES ($1,$2,$3,$4,$5,$6,$7)', [batchId, row.rowNumber, row.legacyRowId, JSON.stringify(row.original), JSON.stringify(row.normalized), row.errors.length ? 'invalid' : 'ready', JSON.stringify(row.errors)]);
    await client.query('UPDATE import_batches SET finished_at=now() WHERE id=$1', [batchId]);
  });
  console.log(`Lote ${batchId} armazenado em staging.`);
}
if (mode === 'publish') {
  if (process.env.IMPORT_PUBLISH_CONFIRM !== 'SIM') throw new Error('Publicação exige IMPORT_PUBLISH_CONFIRM=SIM.');
  const publishable = normalizedRows.filter((row) => row.errors.length === 0);
  await withTransaction(async (client) => {
    for (const row of publishable) {
      const c = row.normalized;
      await client.query(`INSERT INTO contracts (legacy_row_id, contract_number, contract_year, contractor_name, contractor_document, description, object_type, original_value, current_value, start_date, end_date, status, lot, directorate, dispatch_status, dispatch_text, legacy_payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (legacy_row_id) DO UPDATE SET contract_number=excluded.contract_number, contract_year=excluded.contract_year, contractor_name=excluded.contractor_name, contractor_document=excluded.contractor_document, description=excluded.description, object_type=excluded.object_type, original_value=excluded.original_value, current_value=excluded.current_value, start_date=excluded.start_date, end_date=excluded.end_date, status=excluded.status, lot=excluded.lot, directorate=excluded.directorate, dispatch_status=excluded.dispatch_status, dispatch_text=excluded.dispatch_text, legacy_payload=excluded.legacy_payload, version=contracts.version+1, updated_at=now()`, [c.legacy_row_id, c.contract_number, c.contract_year, c.contractor_name, c.contractor_document, c.description, c.object_type, c.original_value, c.current_value, c.start_date, c.end_date, c.status, c.lot, c.directorate, c.dispatch_status, c.dispatch_text, JSON.stringify(c.legacy_payload)]);
    }
  });
  console.log(`Publicação concluída: ${publishable.length} registros; ${normalizedRows.length - publishable.length} pendentes de revisão.`);
}
