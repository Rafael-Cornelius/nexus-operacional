# Estado atual do Nexus Operacional

Atualizado em: 2026-07-18

Este documento descreve a versao vigente da plataforma. O relatorio de lacunas de 2026-05-26 foi preservado apenas como historico em [`archive/implementation-gap-report-2026-05-26.md`](archive/implementation-gap-report-2026-05-26.md).

## Veredito

O Nexus Operacional possui uma base valida para homologacao controlada e uso paralelo ao Excel. Ainda nao deve substituir sozinho a planilha nem ser tratado como um MES industrial concluido.

## Implementado e verificado

- Aplicacoes Next.js e NestJS separadas, com Prisma e PostgreSQL como persistencia operacional.
- Aplicacao operacional com build Next.js normal; a exportacao estatica e habilitada somente no preview publico por `NEXUS_STATIC_DEMO=true`.
- Container web operacional executando o servidor standalone do Next.js, com proxy de mesma origem `/api` para `API_INTERNAL_URL`.
- Preview demonstrativo isolado por `NEXT_PUBLIC_DEMO_MODE`, sem fallback para dados ficticios quando a API operacional falha.
- Autenticacao real pela API, sessao em cookie HTTP-only, `/auth/me`, logout e RBAC.
- Toda requisicao protegida revalida usuario, papeis e `sessionVersion` no PostgreSQL; desativacao, reset de senha, troca de papel ou revogacao administrativa invalidam JWTs ja emitidos.
- Administracao de usuarios cobre edicao, papeis, ativacao, reset de senha, exclusao logica, restauracao e protecao do ultimo administrador.
- Frontend sem token operacional persistido em `localStorage` e sem credenciais operacionais embutidas. O build estatico publica somente a conta descartavel e identificada do preview demonstrativo.
- Dashboard e modo reuniao alimentados pela API no modo operacional.
- Status e alvos visuais dos KPIs obtidos de `/dashboard/alerts`; a interface nao recalcula limites operacionais fixos.
- Selecao explicita da semana no dashboard, modo reuniao e telas operacionais; a interface nao assume que o primeiro item retornado pela API e a semana correta.
- Cache padrao do Next.js preservado e nenhuma otimizacao experimental de pacotes habilitada sem medicao.
- Equipamentos e turnos modelados no backend, com endpoints protegidos, auditoria e telas administrativas de consulta, criacao, edicao e desativacao.
- Producao, perdas, paradas e dosagem aceitam e validam vinculos de equipamento/turno; equipamento precisa pertencer a linha/setor informado e referencias inativas nao podem ser escolhidas em novos lancamentos.
- Preview de equipamentos e turnos isolado dos dados operacionais. Como ainda nao existe endpoint de catalogo de linhas, a tela de equipamentos exige um UUID real e sugere somente linhas devolvidas pela API.
- Validacao de data dentro da semana, bloqueio de periodos sobrepostos e impedimento de gravacao em semanas fechadas ou arquivadas.
- Producao, perdas e paradas possuem rascunho, submissao, revisao, aprovacao/rejeicao, versao otimista e controles correspondentes no frontend; operador nao altera aprovado nem aprova o proprio envio.
- Dashboard, relatorios, metas, produtividade, sobrepeso e snapshots consideram somente registros aprovados. Semanas nao fecham enquanto houver lancamentos pendentes.
- Metas e alertas usam metricas canonicas, comparador e escopo de setor, sem limites visuais fixos ou direcao invertida.
- Importacao autenticada com upload privado, hash SHA-256, inspecao estrutural do ZIP/XML, limites contra ZIP bomb, subprocesso Python isolado, lote auditavel e quarentena de inconsistencias.
- Reconciliacao por lote compara contagens e totais diretos; apenas ADMIN pode certificar explicitamente um lote sem divergencias e sem erros pendentes.
- Backup diario opcional, retencao, checksum, snapshot consistente em `REPEATABLE READ`, arquivos `0600` e ensaio nao destrutivo de leitura/tipos/contagens.
- CI aplica migrations em PostgreSQL limpo, bloqueia vulnerabilidades altas/criticas e executa lint, typecheck, Vitest, Playwright desktop/mobile e builds.

## Limites atuais

- Seletores de equipamento/turno ainda precisam ser incorporados a todos os formularios; produtividade ainda nao possui CRUD de lancamentos proprio.
- A versao otimista protege concorrencia, mas o historico imutavel por revisao ainda depende dos logs de auditoria e nao de uma tabela temporal dedicada.
- Metas precisam de vigencia, versao e escopo completos por setor, linha, produto, equipamento e turno.
- A importacao ainda nao possui staging editavel/promocao transacional e nao cobre arquivo morto, produtividade, dosagem e todas as formulas da planilha.
- Escrita operacional e gravacao da auditoria ainda nao estao na mesma transacao/outbox.
- Relatorios profissionais em PDF/XLSX, restauracao real em banco separado e drill-down completo permanecem pendentes.
- O ensaio de backup atual valida checksum, formato, tipos e contagens em tabelas temporarias; ele nao substitui um teste real de disaster recovery.
- `npm audit` nao aponta vulnerabilidade alta/critica; restam duas moderadas no PostCSS fixado internamente pelo Next.js, documentadas sem aplicar downgrade forcado.

## Regra de uso

- Homologacao com dados controlados: permitida.
- Operacao paralela ao Excel: permitida com backup e supervisao.
- Substituicao integral do Excel: nao liberada.
- GitHub Pages: apenas preview demonstrativo, nunca dados reais.
- Producao: API, PostgreSQL, segredos fortes, HTTPS, backup e monitoramento obrigatorios.

## Criterios para substituir a planilha

1. Reconciliar totais e registros de todas as abas relevantes entre Excel e PostgreSQL.
2. Concluir o vinculo de equipamentos e turnos nos lancamentos, alem de aprovacao, versionamento e rastreabilidade antes/depois.
3. Validar restauracao de backup em ambiente separado.
4. Homologar relatorios e calculos com os responsaveis operacionais.
5. Cobrir os fluxos criticos com testes de integracao e E2E obrigatorios no CI.
6. Executar operacao paralela por periodo acordado, sem divergencias nao explicadas.

## Verificacao local

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

O build do preview deve ser validado separadamente:

```bash
NEXUS_STATIC_DEMO=true NEXT_PUBLIC_DEMO_MODE=true npm run build --workspace=@nexus/web
```

Consulte tambem [`audit-resolution-2026-07-18.md`](audit-resolution-2026-07-18.md), [`production-deploy.md`](production-deploy.md) e [`security-and-import.md`](security-and-import.md).
