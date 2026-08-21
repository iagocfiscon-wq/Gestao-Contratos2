import type { Contract, ContractFilters, CurrentUser } from '../../../packages/shared/src/index';

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include', headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) }, ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? 'Não foi possível concluir a operação.');
  return payload;
}

export const api = {
  me: () => request<{ data: CurrentUser }>('/auth/me'),
  login: (username: string, password: string) => request<{ data: CurrentUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  visitor: () => request<{ data: CurrentUser }>('/auth/visitor', { method: 'POST' }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  contracts: (filters: ContractFilters = {}) => {
    const params = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)); });
    return request<{ data: Contract[]; meta: { page: number; pageSize: number; total: number; totalValue: number } }>(`/contracts?${params.toString()}`);
  },
  contract: (id: string) => request<{ data: Contract }>(`/contracts/${id}`),
  createContract: (payload: Partial<Contract>) => request<{ data: Contract }>('/contracts', { method: 'POST', body: JSON.stringify(payload) }),
  updateContract: (id: string, payload: Partial<Contract>) => request<{ data: Contract }>(`/contracts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteContract: (id: string, reason?: string) => request<{ data: { id: string; deleted: boolean } }>(`/contracts/${id}`, { method: 'DELETE', body: JSON.stringify({ reason }) }),
  restoreContract: (id: string) => request<{ data: Contract }>(`/contracts/${id}/restore`, { method: 'POST' }),
  summary: () => request<{ data: Record<string, unknown> }>('/dashboard/summary'),
  charts: () => request<{ data: Record<string, unknown> }>('/dashboard/charts'),
  timeline: () => request<{ data: Array<Record<string, unknown>> }>('/timeline'),
  pendencias: () => request<{ data: Array<Record<string, unknown>> }>('/pendencias'),
  quality: () => request<{ data: Record<string, unknown> }>('/quality/summary'),
  qualityFindings: () => request<{ data: Array<Record<string, unknown>> }>('/quality/findings'),
  duplicates: () => request<{ data: Array<Record<string, unknown>> }>('/duplicates'),
  audit: () => request<{ data: Array<Record<string, unknown>> }>('/audit-events'),
  trash: () => request<{ data: Contract[] }>('/trash'),
  dispatchPreview: (id: string) => request<{ data: { text: string; status: string } }>(`/contracts/${id}/dispatch/preview`, { method: 'POST' }),
  dispatchGenerate: (id: string, text: string) => request(`/contracts/${id}/dispatch/generate`, { method: 'POST', body: JSON.stringify({ text }) }),
  dispatchSend: (id: string) => request(`/contracts/${id}/dispatch/send`, { method: 'POST', body: JSON.stringify({ confirmation: true }) })
};
