import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS, daysUntil, hasPermission, isInactiveStatus, isValidCnpj, normalizeText, parseBrazilianNumber } from './index.js';

describe('regras compartilhadas C-FISCON', () => {
  it('normaliza texto acentuado para comparações estáveis', () => {
    expect(normalizeText(' Início da Vigência ')).toBe('inicio da vigencia');
  });
  it('valida CNPJ e rejeita sequências inválidas', () => {
    expect(isValidCnpj('00.000.000/0001-91')).toBe(true);
    expect(isValidCnpj('11.111.111/1111-11')).toBe(false);
    expect(isValidCnpj('12.345.678/0001-00')).toBe(false);
  });
  it('interpreta valores brasileiros', () => {
    expect(parseBrazilianNumber('R$ 1.234,56')).toBe(1234.56);
    expect(parseBrazilianNumber('250000')).toBe(250000);
    expect(parseBrazilianNumber('')).toBeNull();
  });
  it('calcula vencimento e status inativo', () => {
    expect(daysUntil('2026-01-02', new Date('2026-01-01T12:00:00'))).toBe(1);
    expect(isInactiveStatus('Encerrado')).toBe(true);
    expect(isInactiveStatus('Vigente')).toBe(false);
  });
  it('mantém RBAC explícito', () => {
    expect(hasPermission('ADMINISTRADOR', 'delete')).toBe(true);
    expect(hasPermission('LEITURA', 'delete')).toBe(false);
    expect(ROLE_DEFINITIONS.VISITANTE.permissions).toContain('read');
  });
});
