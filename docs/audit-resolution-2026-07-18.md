# Resolucao da auditoria tecnica — 18/07/2026

Este registro documenta a correcao dos dez itens de prioridade zero identificados na auditoria da versao atual.

## Prioridade zero

1. Dashboard operacional passou a carregar dados autenticados da API por semana; fixtures existem somente em `apps/web/lib/demo/` e apenas quando `NEXT_PUBLIC_DEMO_MODE=true`.
2. Apresentacao executiva passou a usar `/presentations/executive`, com semana, status, origem e data de geracao. O preview demonstrativo esta isolado.
3. O build operacional nao usa `output: "export"` nem `basePath`. A exportacao estatica so e habilitada por `NEXUS_STATIC_DEMO=true`.
4. GitHub Pages continua manual e exclusivo para demo sem dados reais.
5. `ignoreDuringBuilds` foi removido; lint e validacao de tipos bloqueiam o build.
6. O frontend nao armazena nem envia bearer token. A sessao real usa apenas o cookie HTTP-only `nexus_session`.
7. Producao, perdas, paradas e dosagem validam a data contra o intervalo da semana.
8. A criacao ou alteracao de semanas bloqueia periodos sobrepostos.
9. Semanas `CLOSED` ou `ARCHIVED` bloqueiam criacao, duplicacao, exclusao e importacao de lancamentos. Transicoes de estado tambem foram restringidas.
10. `build-output.txt`, `apps/web/tsconfig.tsbuildinfo` e arquivos locais `project_info__*.md` foram removidos; regras de ignore foram ampliadas.

## Evidencias executadas

- Lint: aprovado em API e Web.
- Typecheck: aprovado em API e Web.
- Vitest: 25 testes aprovados.
- Build operacional: aprovado em API e Web.
- Build estatico de demo: aprovado separadamente.
- Playwright: login e dashboard aprovados em desktop e mobile.
- Revisao visual: 13 rotas desktop renderizadas sem tela preta.

## Itens ainda pendentes da auditoria

As prioridades alta, intermediaria e gerencial nao foram declaradas como concluidas. Permanecem, entre outros, cadastro de equipamentos e turnos, CRUDs completos, aprovacao/versionamento, staging e reconciliacao integral do Excel, relatorios PDF/XLSX e restauracao testada de backup.
