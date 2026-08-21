import { expect, test, type Page } from '@playwright/test';

const adminUsername = process.env.ADMIN_USERNAME ?? '';
const adminPassword = process.env.ADMIN_PASSWORD ?? '';

function requireAdminEnvironment() {
  if (!adminUsername || !adminPassword) {
    throw new Error('ADMIN_USERNAME e ADMIN_PASSWORD devem estar definidos no ambiente do teste; nenhum valor é exibido ou armazenado pelo teste.');
  }
}

async function loginAsAdmin(page: Page) {
  requireAdminEnvironment();
  await page.goto('/');
  await page.getByLabel('Usuário').fill(adminUsername);
  await page.getByLabel('Senha').fill(adminPassword);
  await page.getByRole('button', { name: /Entrar com segurança/i }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  await expect(page.getByText('Contratos na base')).toBeVisible();
}

test('exibe a tela de autenticação C-FISCON', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Gestão de Contratos/);
  await expect(page.getByText('Gestão de')).toBeVisible();
  await expect(page.getByRole('button', { name: /Entrar com segurança/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /Acessar como visitante/i })).toBeVisible();
});

test('administrador executa CRUD, controle de versão, lixeira, auditoria e exportação', async ({ page }) => {
  await loginAsAdmin(page);
  const contractNumber = `E2E-${Date.now()}`;

  await page.getByRole('button', { name: 'Novo contrato' }).click();
  await expect(page.getByRole('heading', { name: 'Cadastrar contrato' })).toBeVisible();
  await page.getByLabel('Número do contrato *').fill(contractNumber);
  await page.getByLabel('Ano').selectOption('2026');
  await page.getByLabel('Contratado').fill('Empresa Sintética E2E LTDA');
  await page.getByLabel('Objeto', { exact: true }).fill('Serviço sintético de validação');
  await page.getByLabel('Descrição do objeto', { exact: true }).fill('Registro criado exclusivamente pelo teste automatizado.');
  await page.getByLabel('Início da vigência').fill('2026-01-01');
  await page.getByLabel('Final da vigência').fill('2026-12-31');
  await page.getByLabel('Valor original').fill('1000');
  await page.getByLabel('Valor atual').fill('1200');
  await page.getByRole('button', { name: 'Salvar contrato' }).click();
  await expect(page.getByText('Contrato criado com sucesso.')).toBeVisible();

  const row = page.locator('tr').filter({ hasText: contractNumber });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Editar' }).click();
  await expect(page.getByRole('heading', { name: `Contrato ${contractNumber}` })).toBeVisible();
  await page.getByLabel('Valor atual').fill('1300');
  await page.getByRole('button', { name: 'Salvar contrato' }).click();
  await expect(page.getByText('Contrato atualizado com sucesso.')).toBeVisible();

  const listResponse = await page.request.get(`/api/contracts?search=${encodeURIComponent(contractNumber)}&page=1&pageSize=10`);
  expect(listResponse.ok()).toBeTruthy();
  const listPayload = await listResponse.json();
  const contract = listPayload.data[0];
  expect(contract.contract_number).toBe(contractNumber);
  expect(Number(contract.current_value)).toBe(1300);
  expect(Number(contract.version)).toBeGreaterThanOrEqual(2);

  const staleUpdate = await page.request.patch(`/api/contracts/${contract.id}`, {
    data: { version: 1, current_value: 1400 }
  });
  expect(staleUpdate.status()).toBe(409);

  await page.once('dialog', async (dialog) => { await dialog.accept(); });
  await row.getByRole('button', { name: 'Excluir' }).click();
  await expect(page.getByText('Contrato movido para a lixeira.')).toBeVisible();

  await page.getByRole('button', { name: 'Lixeira' }).click();
  const trashRow = page.locator('tr').filter({ hasText: contractNumber });
  await expect(trashRow).toBeVisible();
  await trashRow.getByRole('button', { name: 'Restaurar' }).click();
  await expect(page.getByText('Contrato restaurado.')).toBeVisible();

  const restoredResponse = await page.request.get(`/api/contracts/${contract.id}`);
  expect(restoredResponse.ok()).toBeTruthy();
  const restoredPayload = await restoredResponse.json();
  expect(restoredPayload.data.deleted_at).toBeNull();

  await page.getByRole('button', { name: 'Histórico' }).click();
  await expect(page.getByText('CONTRATO_CRIADO')).toBeVisible();
  await expect(page.getByText('CONTRATO_ATUALIZADO')).toBeVisible();
  await expect(page.getByText('CONTRATO_EXCLUIDO')).toBeVisible();
  await expect(page.getByText('CONTRATO_RESTAURADO')).toBeVisible();

  await page.getByRole('button', { name: 'Exportação' }).click();
  await expect(page.getByRole('heading', { name: 'Leve a carteira com você' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('cfiscon-contratos.csv');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  if (stream) for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toContain(contractNumber);
});

test('visitante consulta contratos mas não pode mutar', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Acessar como visitante/i }).click();
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  await expect(page.getByText('Contratos na base')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Novo contrato' })).toHaveCount(0);

  const listResponse = await page.request.get('/api/contracts?page=1&pageSize=1');
  expect(listResponse.ok()).toBeTruthy();
  const listPayload = await listResponse.json();
  const contractId = listPayload.data[0].id;
  const payload = { contract_number: 'VISITOR-HACK', current_value: 999 };

  const createResponse = await page.request.post('/api/contracts', { data: payload });
  expect(createResponse.status()).toBe(403);
  const updateResponse = await page.request.patch(`/api/contracts/${contractId}`, { data: payload });
  expect(updateResponse.status()).toBe(403);
  const deleteResponse = await page.request.delete(`/api/contracts/${contractId}`, { data: { reason: 'teste visitante' } });
  expect(deleteResponse.status()).toBe(403);
  const restoreResponse = await page.request.post(`/api/contracts/${contractId}/restore`);
  expect(restoreResponse.status()).toBe(403);
});
