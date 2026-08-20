export const ROLE_DEFINITIONS = {
  ADMINISTRADOR: {
    label: 'Administrador',
    permissions: ['read', 'create', 'update', 'delete', 'restore', 'trash_read', 'export', 'report', 'compare', 'audit', 'quality', 'batch_update', 'batch_delete', 'config']
  },
  OPERACIONAL: {
    label: 'Usuário operacional',
    permissions: ['read', 'create', 'update', 'export', 'report', 'compare', 'quality', 'batch_update']
  },
  LEITURA: {
    label: 'Somente leitura',
    permissions: ['read', 'export', 'report', 'compare', 'quality']
  },
  VISITANTE: {
    label: 'Visitante · somente leitura',
    permissions: ['read', 'export', 'report', 'compare', 'audit', 'quality', 'trash_read']
  }
} as const;

export type RoleKey = keyof typeof ROLE_DEFINITIONS;
export type Permission = (typeof ROLE_DEFINITIONS)[RoleKey]['permissions'][number];

export type AssignmentType = 'fiscal' | 'gestor' | 'suplente';

export interface Contract {
  id: string;
  legacy_row_id: string | null;
  instrument: string | null;
  contract_number: string;
  contract_year: number | null;
  company_id: string | null;
  contractor_name: string | null;
  contractor_document: string | null;
  process_number: string | null;
  process_year: number | null;
  description: string | null;
  object_type: string | null;
  original_value: string | number | null;
  current_value: string | number | null;
  signature_date: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string;
  term_text: string | null;
  maximum_term_text: string | null;
  extension_text: string | null;
  law: string | null;
  notes: string | null;
  lot: string | null;
  directorate: string | null;
  dispatch_status: string;
  dispatch_generated_at: string | null;
  dispatch_sent_at: string | null;
  dispatch_text: string | null;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  assignments?: Assignment[];
}

export interface Assignment {
  id: string;
  contract_id: string;
  assignment_type: AssignmentType;
  display_name: string;
  user_id: string | null;
  order_index: number;
  legacy_name: string | null;
  active: boolean;
}

export interface ContractFilters {
  search?: string;
  year?: number;
  status?: string;
  directorate?: string;
  fiscal?: string;
  dueWithin?: number;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CurrentUser {
  id: string;
  name: string;
  username: string;
  email: string | null;
  role_key: RoleKey;
  role_label: string;
  permissions: Permission[];
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeDocument(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

export function isValidCnpj(value: unknown): boolean {
  const digits = normalizeDocument(value);
  if (digits.length !== 14 || /^([0-9])\1+$/.test(digits)) return false;
  const calculate = (base: string) => {
    let factor = base.length - 7;
    let total = 0;
    for (const char of base) {
      total += Number(char) * factor;
      factor = factor === 2 ? 9 : factor - 1;
    }
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculate(digits.slice(0, 12)) === Number(digits[12]) && calculate(digits.slice(0, 13)) === Number(digits[13]);
}

export function parseBrazilianNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/R\$\s?/gi, '').replace(/\s/g, '');
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const parsed = Number(normalized.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isInactiveStatus(value: unknown): boolean {
  const normalized = normalizeText(value);
  return ['encerrado', 'concluido', 'anulado', 'rescindido'].some((status) => normalized.includes(status));
}

export function daysUntil(value: string | Date | null | undefined, now = new Date()): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
}

export function hasPermission(role: RoleKey, permission: Permission): boolean {
  return ROLE_DEFINITIONS[role].permissions.includes(permission as never);
}
