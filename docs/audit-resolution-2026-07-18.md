# Resolucao da auditoria tecnica — 18/07/2026

Este registro documenta a correcao dos dez itens de prioridade zero identificados na auditoria da versao atual.

## Prioridade zero

1. Dashboard operacional passou a carregar dados autenticados da API por semana; fixtures existem somente em `apps/web/lib/demo/` e apenas quando `NEXT_PUBLIC_DEMO_MODE=true`.
2. Apresentacao executiva passou a usar `/presentations/executive`, com semana, status, origem e data de geracao. O preview demonstrativo esta isolado.
3. O build operacional nao usa `output: "export"` nem `basePath`. A exportacao estatica so e habilitada por `NEXUS_STATIC_DEMO=true`.
4. GitHub Pages e exclusivo para demo sem dados reais e atualiza automaticamente em `main` e na branch de homologacao; a credencial exibida e publica e nao autentica na API.
5. `ignoreDuringBuilds` foi removido; lint e validacao de tipos bloqueiam o build.
6. O frontend nao armazena nem envia bearer token. A sessao real usa apenas o cookie HTTP-only `nexus_session`.
7. Producao, perdas, paradas e dosagem validam a data contra o intervalo da semana.
8. A criacao ou alteracao de semanas bloqueia periodos sobrepostos.
9. Semanas `CLOSED` ou `ARCHIVED` bloqueiam criacao, duplicacao, exclusao e importacao de lancamentos. Transicoes de estado tambem foram restringidas.
10. `build-output.txt`, `apps/web/tsconfig.tsbuildinfo` e arquivos locais `project_info__*.md` foram removidos; regras de ignore foram ampliadas.

## Hardening adicional entregue

- CI obrigatorio com PostgreSQL limpo, migrations, auditoria de dependencias, lint, typecheck, Vitest, Playwright e builds.
- Atualizacao revisada de Next, NestJS, Multer, ECharts, Vitest/Vite, ESLint, Playwright, Turbo e ferramentas relacionadas; zero vulnerabilidade alta/critica no `npm audit`.
- CRUD completo de producao, perdas e paradas, com exclusao logica/restauracao, validacao de referencias e concorrencia otimista HTTP 409.
- Workflow de rascunho, submissao, revisao, aprovacao e rejeicao no backend e frontend. Registros legados entram `UNDER_REVIEW`; importados entram `DRAFT`.
- Segregacao: operador nao altera aprovado e o remetente nao aprova o proprio lancamento. Semana com pendencia nao fecha.
- Equipamentos e turnos no banco, API e telas administrativas; vinculos validados em producao, perdas, paradas e dosagem.
- Administracao de usuarios, protecao do ultimo ADMIN e revogacao imediata de JWT por `sessionVersion`.
- Metas/alertas corrigidos para metrica canonica, comparador e setor; producao e avaliada como “maior e melhor”.
- Periodos de preco e semanas protegidos contra sobreposicao no servico e no PostgreSQL.
- Importacao XLSX isolada, com validacao estrutural, limites contra ZIP bomb, preservacao integral dos erros e bloqueio de importacoes concorrentes/certificadas.
- Linhagem `importBatchId`, reconciliacao ampliada e certificacao manual ADMIN auditada.
- Backup agendado com retencao, checksum, snapshot transacional e ensaio de restauracao nao destrutivo.
- Exportacao CSV com quoting, neutralizacao de formulas e codificacao compativel com Excel.

## Evidencias executadas

- Lint: aprovado em API e Web.
- Typecheck: aprovado em API e Web.
- Vitest: 118 testes aprovados em 23 arquivos na validacao local final.
- Build operacional: aprovado em API e Web.
- Build estatico de demo: aprovado separadamente.
- Playwright: 34/34 cenarios aprovados em Chromium desktop e mobile, incluindo login, dashboard, rotas revisadas e CRUD demonstrativo de equipamentos/turnos.
- Rotas de preview e telas operacionais foram renderizadas com CSS carregado e sem tela preta.

## Itens ainda pendentes da auditoria

O projeto esta liberado apenas para homologacao controlada e operacao paralela ao Excel. Ainda faltam staging editavel e promocao integralmente transacional, cobertura de todas as abas, metas temporais/versionadas, historico temporal imutavel, auditoria atomica com a escrita, relatorios PDF/XLSX e restauracao real em banco separado. Esses itens impedem declarar substituicao integral da planilha.
