# C-FISCON · Gestão de Contratos

Plataforma full-stack para controle interno, fiscalização e análise de contratos administrativos do DMAE. O projeto transforma o dashboard legado conectado ao Google Sheets em uma aplicação com PostgreSQL, API Fastify, frontend React, autenticação segura, RBAC, versionamento, auditoria e importação controlada do Excel legado.

## O que está implementado

A primeira versão funcional inclui login com Argon2id, sessão por cookie HttpOnly, expiração, bloqueio progressivo e modo visitante somente leitura. O servidor aplica as permissões no backend; esconder botões no frontend é apenas uma camada complementar de experiência.

A carteira permite consulta paginada, busca global, filtro por situação, cadastro, edição com controle otimista de versão, exclusão reversível e restauração. O dashboard possui visão geral, indicadores de valor e vencimento, fiscais, gráficos, timeline, central de pendências, qualidade da base, duplicidades, histórico, lixeira e exportação CSV.

O domínio também contém geração de minuta de despacho de renovação com revisão explícita antes do envio, seleção de modelo versionado, trilha de auditoria, snapshots de contrato, importação em staging e publicação idempotente pelo `legacy_row_id`. Documentos e dados reais não são incluídos no repositório.

## Arquitetura

| Camada | Implementação | Responsabilidade |
| --- | --- | --- |
| Web | React 19 + Vite + CSS tokens | Dashboard responsivo, formulários, estados e navegação |
| API | Fastify 5 + TypeScript | HTTP, RBAC, validações, consultas, auditoria e operações críticas |
| Banco | PostgreSQL 16 | Contratos, cadastros mestres, responsáveis, sessões, versões, documentos, importação e qualidade |
| Scripts | TypeScript + SheetJS | Migração, seed, análise, staging, publicação e verificação |
| Ambiente | Devcontainer + Docker Compose | Codespaces reproduzível com PostgreSQL persistente |

## Execução local ou Codespaces

Instale Node.js 22, pnpm e Docker. Em Codespaces, o `devcontainer.json` instala as dependências e inicia o serviço de PostgreSQL automaticamente.

```bash
cp .env.example .env
# Edite DATABASE_URL e ADMIN_PASSWORD; nunca commite .env.
pnpm install
docker compose up -d db
pnpm db:migrate
pnpm db:seed
pnpm dev
```

O dashboard abre em `http://localhost:5173`, a API em `http://localhost:3333` e a documentação OpenAPI em `http://localhost:3333/docs`. Para criar dados sintéticos, execute o seed com `SEED_DEMO=true`; os dados carregados são explicitamente fictícios.

## Importação do legado

O fluxo é deliberadamente separado em análise, staging e publicação. Primeiro, coloque o arquivo Excel somente no ambiente local, fora do Git, e gere o relatório:

```bash
WORKBOOK_PATH=./data/legacy/contratos.xlsx pnpm db:inspect
WORKBOOK_PATH=./data/legacy/contratos.xlsx IMPORT_MODE=stage pnpm db:import
```

O staging preserva o payload original, o payload normalizado, número da linha, erros e status. Revise o relatório em `storage/imports/`. A publicação exige confirmação explícita para impedir migrações acidentais:

```bash
WORKBOOK_PATH=./data/legacy/contratos.xlsx IMPORT_MODE=publish IMPORT_PUBLISH_CONFIRM=SIM pnpm db:import
```

O publicador usa `legacy_row_id` como chave idempotente e não duplica registros em reexecuções. Linhas com CNPJ inválido, documento incompatível, número ausente, vigência invertida ou outras falhas ficam pendentes para correção.

## Segurança e governança

As senhas são armazenadas somente como hash Argon2id. Sessões usam token aleatório cujo hash é persistido, com cookie HttpOnly, SameSite Lax, expiração e revogação no logout. O rate limit e os headers de segurança estão habilitados no Fastify. O sistema nunca registra senha, token, cookie ou conteúdo sensível nos logs.

Toda mutação relevante grava ator, perfil, ação, entidade, identificador, antes/depois, origem e resultado. Contratos são excluídos por soft delete. Atualizações exigem o número de versão esperado e retornam conflito quando outro usuário alterou o mesmo registro. Uploads e documentos devem ser adicionados somente depois de revisão de retenção e autorização institucional.

## Testes e verificação

```bash
pnpm test
pnpm lint
pnpm build
pnpm db:verify
pnpm test:e2e
```

Os testes unitários cobrem normalização, CNPJ, valores brasileiros, datas, status e permissões. O smoke test valida a abertura do dashboard e a tela de autenticação. O pipeline não substitui uma homologação com dados anonimizados, revisão de perfis e validação jurídica do texto de despacho.

## Deploy e operação

Configure `DATABASE_URL`, `ADMIN_PASSWORD`, `CORS_ORIGIN`, `NODE_ENV=production` e um segredo de infraestrutura fora do Git. Execute a migração em uma janela controlada, valide `pnpm db:verify`, faça o seed apenas quando necessário e rode o servidor com `pnpm start`. Em produção, use TLS no proxy, backup automatizado do PostgreSQL, monitoramento de erros, política de retenção e restauração testada.

## Convenções

Não são aceitos segredos, planilhas reais, PDFs institucionais, arquivos `.env`, dumps de banco ou credenciais no repositório. Mudanças de schema devem vir acompanhadas de migração, verificação e teste. Regras de permissão devem permanecer no servidor; o frontend deve apenas refletir a autorização para melhorar a experiência.
