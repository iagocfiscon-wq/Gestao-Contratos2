import { test, expect } from '@playwright/test';

test('exibe a tela de autenticação C-FISCON', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Gestão de Contratos/);
  await expect(page.getByText('Gestão de')).toBeVisible();
  await expect(page.getByRole('button', { name: /Entrar com segurança/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Acessar como visitante/i })).toBeVisible();
});
