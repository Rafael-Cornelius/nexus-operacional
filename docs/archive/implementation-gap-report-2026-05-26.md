# Relatorio de lacunas de implementacao

> Documento historico preservado como retrato da auditoria de 2026-05-26. Para o estado vigente, consulte [`../current-status.md`](../current-status.md).

Data da auditoria: 2026-05-26

## Escopo lido

- `README.md`, `package.json`, workspaces `apps/web` e `apps/api`.
- `prisma/schema.prisma`, `prisma/migrations/0001_init/migration.sql` e `prisma/seed.ts`.
- Modulos NestJS de autenticacao, producao, perdas, paradas, produtividade, semanas, dashboard, metas, importacao, auditoria, relatorios, apresentacoes, usuarios e backups.
- Telas Next.js, componentes de layout, formularios, dashboard e modo reuniao.
- Scripts Python de importacao, limpeza e plano de migracao.
- Docker, Docker Compose, workflow de GitHub Pages e documentacao existente.
- Testes unitarios, integracao e E2E presentes.

Observacao: nenhum arquivo `.xlsx` foi encontrado dentro do repositorio. A planilha original precisa ser informada via `LEGACY_EXCEL_PATH` ou encontrada fora do repositorio para reconciliacao integral.

## Funcionalidades ja implementadas

- Monorepo com Next.js, NestJS, Prisma, PostgreSQL, Docker e testes.
- Schema inicial com usuarios, papeis, permissoes, setores, linhas, produtos, configuracoes de peso, semanas, producao, perdas, paradas, produtividade, metas, auditoria, importacoes, relatorios, apresentacoes e backups.
- Guards globais de JWT e RBAC no backend.
- Login backend com `bcrypt` e emissao de JWT.
- Modulos iniciais de producao P1/P2 com calculo no backend, preview e gravacao basica.
- Modulos iniciais de perdas, paradas, produtividade, semanas, dashboard, metas, auditoria, importacao, relatorios, apresentacoes, usuarios e backups.
- Scripts Python que inspecionam XLSX sem Excel instalado e tratam erros como `#DIV/0!`, `#N/A`, `#REF!` e `#VALUE!`.
- Importacao atual de catalogo de produtos a partir das abas `Pacotes-caixas` e `Banco de Dados Pesagen`.
- Documentacao inicial de seguranca, importacao, formulas e deploy.

## Funcionalidades incompletas

- Autenticacao do frontend ainda usava sessao local simulada e token em `localStorage`.
- Rotas privadas do frontend nao tinham bloqueio real antes de renderizar conteudo.
- Dashboard e diversas paginas usavam fallback local quando a API falhava ou nao havia sessao.
- Importacao completa da planilha ainda nao cobre producao P1/P2, perdas, paradas, sobrepeso, produtividade e arquivo morto.
- Semanas possuem intervalo explicito, mas ainda nao validam sobreposicao nem garantem regra operacional completa.
- Producao ainda nao possui edicao, restauracao, paginacao ampla, filtros completos e uso de metas dinamicas.
- Perdas e paradas possuem criacao/listagem basicas, mas ainda faltam CRUD completo, restauracao, validacoes avancadas e rankings finais.
- Relatorios e apresentacoes ainda retornam saidas iniciais, sem PDF/XLSX profissional.
- Backups ainda precisam de restauracao validada, download protegido, retencao e checksum operacional.
- Auditoria existe, mas nao cobre todas as operacoes criticas nem comparacao antes/depois em todas as telas.

## Funcionalidades inexistentes ou insuficientes

- Fluxo profissional de upload XLSX com staging, hash SHA-256, preview, correcao de inconsistencias, confirmacao administrativa e importacao transacional.
- Tela para resolver as 127 inconsistencias de importacao.
- Reconciliacao formal planilha x banco.
- Sessao segura completa com refresh token, expiracao coordenada e troca obrigatoria de senha inicial.
- Rate limiting especifico para login/importacao/exportacao/backups.
- Politica de senha e bloqueio por excesso de tentativas.
- Deploy operacional privado como caminho principal de producao.
- Testes de seguranca para impedir vazamento de dados reais no bundle publico.

## Riscos de seguranca

- `apps/web/services/api.ts` continha `local-admin-session`, email e senha padrao expostos no cliente.
- A sessao do frontend era persistida em `localStorage`, expondo token sensivel a XSS.
- O frontend aceitava fallback local quando a API real estava indisponivel, mascarando falhas de autenticacao.
- `prisma/seed.ts` e `.env.example` ainda documentam uma senha inicial padrao; aceitavel apenas para desenvolvimento, mas inseguro como orientacao de producao.
- `JWT_ACCESS_SECRET` possui fallback de desenvolvimento no codigo; deve falhar em producao se nao houver segredo forte.

## Riscos de exposicao de dados

- `apps/web/lib/legacy-data.json` contem dados derivados da planilha e era importado diretamente pelo frontend.
- `apps/web/lib/demo-data.ts` derivava KPIs, rankings e graficos desse JSON.
- O workflow de GitHub Pages publica frontend estatico, o que tornaria qualquer dado importado para o bundle acessivel publicamente.
- `scripts/export_legacy_web_data.py` tinha saida padrao para `apps/web/lib/legacy-data.json`, incentivando novo vazamento.

## Problemas de banco e modelagem

- `LossEntry.productionOrderId` nao possui relacao Prisma declarada com `ProductionOrder`.
- `ProductivityEntry.weekId` nao possui relacao Prisma declarada com `WeeklyPeriod`.
- Campos `createdBy` e `updatedBy` existem em varias entidades, mas nao estao consistentemente relacionados a `User`.
- Semanas nao impedem sobreposicao por regra de banco ou validacao robusta.
- Nao ha controle de concorrencia/versionamento para registros criticos.
- Metas nao possuem validade por periodo, escopo completo ou versionamento.

## Problemas de deploy

- `apps/web/next.config.ts` usa `output: "export"` e `basePath` de GitHub Pages, incompatibilizando o frontend operacional com protecao de servidor.
- O workflow `.github/workflows/pages.yml` publica frontend estatico como caminho automatico em `main`.
- Docker Compose existe, mas ainda usa defaults fracos para banco e segredos se `.env` nao for ajustado.

## Problemas de importacao

- Importacao atual normaliza principalmente produtos.
- Nao ha upload autenticado, staging, resolucao de inconsistencias, confirmacao transacional ou rollback.
- `ImportError` nao possui status de resolucao, justificativa, usuario responsavel ou data de resolucao.
- A reconciliacao total planilha x banco ainda nao existe.

## Problemas de regras de negocio

- Metas criticas ainda aparecem fixadas em codigo de dominio.
- Produção valida semana aberta/fechada, mas nao valida que a data do lancamento pertence ao intervalo da semana.
- Regras de semana nao bloqueiam sobreposicao.
- Paradas ainda precisam validar sobreposicao por linha.
- Sobrepeso e produtividade ainda dependem de agregacoes iniciais e nao possuem fluxo operacional completo.

## Plano ordenado de correcao

1. Remover dados reais do frontend e impedir importacao de JSON legado no bundle.
2. Remover administrador local, token falso e persistencia de token sensivel em `localStorage`.
3. Implementar cookie HTTP-only no backend, `/auth/me` e logout real.
4. Proteger todas as rotas privadas do frontend com verificacao de sessao real.
5. Atualizar telas para carregarem dados apenas da API autenticada, com estados vazios/erro em vez de fallback da planilha.
6. Desativar GitHub Pages operacional e documentar que Pages so pode ser demo sem dados reais.
7. Corrigir schema Prisma, migrations e regras de semana.
8. Implementar importacao XLSX completa com staging, inconsistencias e reconciliacao.
9. Completar CRUDs operacionais, calculos, metas, auditoria, relatorios, backups e testes.

## Criterios de aceite verificaveis da Fase 1

- `apps/web/lib/legacy-data.json` nao existe ou nao contem dados reais.
- Nenhum arquivo de `apps/web` importa `legacy-data.json`.
- Nenhum arquivo de `apps/web` contem `local-admin-session`, `NEXT_PUBLIC_LOCAL_ADMIN_PASSWORD` ou `NEXT_PUBLIC_ENABLE_LOCAL_ADMIN`.
- Login chama somente `/auth/login` no backend.
- Backend grava cookie HTTP-only de sessao e fornece `/auth/me`.
- Logout limpa a sessao no backend e no cliente.
- Rotas privadas redirecionam para `/login` quando `/auth/me` falha.
- Chamadas autenticadas usam `credentials: "include"` e nao dependem de token sensivel no `localStorage`.
- Teste automatizado falha se dados legados reais ou credenciais administrativas reaparecerem no frontend.
