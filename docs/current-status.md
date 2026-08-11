# Estado atual do Nexus Operacional

Atualizado em: 2026-08-10

Este documento descreve a versao vigente da plataforma. O relatorio de lacunas de 2026-05-26 foi preservado apenas como historico em [`archive/implementation-gap-report-2026-05-26.md`](archive/implementation-gap-report-2026-05-26.md).

## Veredito

O Nexus Operacional possui uma base valida para homologacao controlada e uso paralelo ao Excel. Ainda nao deve substituir sozinho a planilha nem ser tratado como um MES industrial concluido.

## Implementado e verificado

- Aplicacoes Next.js e NestJS separadas, com Prisma e PostgreSQL como persistencia operacional.
- Aplicacao operacional com build Next.js normal; a exportacao estatica e habilitada somente no preview publico por `NEXUS_STATIC_DEMO=true`.
- Container web operacional executando o servidor standalone do Next.js, com proxy de mesma origem `/api` para `API_INTERNAL_URL`.
- Preview demonstrativo isolado por `NEXT_PUBLIC_DEMO_MODE`, sem fallback para dados ficticios quando a API operacional falha.
- Autenticacao real pela API, sessao em cookie HTTP-only `Secure`/`SameSite=Lax|Strict`, proteção de origem em mutações, `/auth/me`, logout e RBAC.
- Toda requisicao protegida revalida usuario, papeis e `sessionVersion` no PostgreSQL; desativacao, reset de senha, troca de papel ou revogacao administrativa invalidam JWTs ja emitidos.
- Administracao de usuarios cobre edicao, papeis, ativacao, reset de senha, exclusao logica, restauracao e protecao do ultimo administrador.
- Frontend sem token operacional persistido em `localStorage` e sem credenciais operacionais embutidas. O build estatico publica somente a conta descartavel e identificada do preview demonstrativo.
- Dashboard e modo reuniao alimentados pela API no modo operacional.
- Status e alvos visuais dos KPIs obtidos de `/dashboard/alerts`; a interface nao recalcula limites operacionais fixos.
- Selecao explicita da semana no dashboard, modo reuniao e telas operacionais; a interface nao assume que o primeiro item retornado pela API e a semana correta.
- Cache padrao do Next.js preservado e nenhuma otimizacao experimental de pacotes habilitada sem medicao.
- Setores, linhas, tipos de perda e motivos de parada possuem cadastro-base protegido; equipamentos e turnos possuem endpoints, auditoria e telas administrativas de consulta, criacao, edicao e desativacao.
- Producao, perdas, paradas e dosagem aceitam e validam vinculos de equipamento/turno; equipamento precisa pertencer a linha/setor informado e referencias inativas nao podem ser escolhidas em novos lancamentos.
- Preview de cadastros isolado dos dados operacionais. A tela de equipamentos usa o catalogo real de linhas da API, sem entrada manual de UUID.
- Validacao de data dentro da semana, bloqueio de periodos sobrepostos e impedimento de gravacao em semanas fechadas ou arquivadas.
- Producao, perdas, paradas, dosagem e produtividade possuem rascunho, submissao, revisao, aprovacao/rejeicao, versao otimista e controles correspondentes no frontend; operador nao altera aprovado nem aprova o proprio envio.
- Dashboard, relatorios, metas, produtividade, sobrepeso e snapshots consideram somente registros aprovados. Semanas nao fecham enquanto houver lancamentos pendentes.
- Metas e alertas usam metricas canonicas, comparador e escopo de setor, sem limites visuais fixos ou direcao invertida.
- Metas possuem séries/versionamento imutável, vigência, unidade, escopo por setor/linha/equipamento/turno/produto, responsável, aprovação independente, retirada e bloqueio PostgreSQL de sobreposição. Legados permanecem `DRAFT`.
- Preços possuem `DRAFT/APPROVED/RETIRED`, versão imutável, moeda, origem, responsável/aprovador independente e vigência. Produção/perdas usam somente preço aprovado vigente e gravam ID, versão, origem e moeda usados.
- Regras de cálculo estão centralizadas e versionadas; versões executadas são persistidas nos lançamentos e snapshots. Regras ambíguas ficam em `REVIEW_REQUIRED`, exigem decisão humana auditada e bloqueiam a aprovação dos lançamentos dependentes enquanto não aprovadas.
- Importacao autenticada com upload privado, hash SHA-256, inspecao estrutural do ZIP/XML, limites contra ZIP bomb, subprocesso Python isolado, staging editável, revisão humana e promoção serializável/atômica.
- O parser v4 preserva linhas incompletas e 1.613 células com cache de erro ou referência quebrada; não inventa OP, nome, setor, fórmula, tolerância, estado ativo, peso derivado nem zero para valor ausente.
- Perdas de embalagem preservam filme em kg e caixas em unidades, ambos separados por T1/T2. Ausente não vira zero e caixas nunca são somadas a quilogramas.
- As 60 amostras órfãs de dosagem e 165 registros materializados do `ARQUIVO MORTO` são preservados com linhagem em quarentena não promovível.
- Correção/revisão do staging usa versão otimista, auditoria antes/depois e a mesma transação da mutação. Promoção exige ator rastreável e não aceita preço da planilha como preço aprovado.
- Reconciliacao por lote compara Excel, staging e PostgreSQL, incluindo dimensões T1/T2 e caixas, e inclui valores corrigidos/linhagem no hash. Apenas ADMIN pode certificar explicitamente lote elegível.
- Concorrência de produção, fechamento/reabertura de semanas e paradas possui locks/restrições; cópias concorrentes recebem sufixos únicos e duplicata exige igualdade operacional exata.
- Relatórios operacionais CSV/XLSX/PDF são gerados de registros aprovados no PostgreSQL, auditados e incluem dimensões de perdas sem misturar unidades.
- Backup PostgreSQL nativo diário cifrado com AES-256-GCM, retenção auditada, checksum e cópia externa. Existe prova de restauração real para um segundo PostgreSQL vazio e descartável, com confirmação nominal, checksum externo e conferência pós-commit de conteúdo, estrutura, migrations e sequences.
- Bootstrap operacional cria somente RBAC, administrador configurado e empresa opcional. Não cria semanas, produtos, metas nem lançamentos; o seed demonstrativo é separado e recusado em produção.
- Login bem-sucedido, mutações de usuários e CRUDs centrais gravam alteração e auditoria na mesma transação. Login inválido reduz enumeração por conteúdo e tempo.
- Health público verifica conectividade real com PostgreSQL e retorna indisponibilidade quando o banco falha.
- O E2E operacional em nível HTTP/API executa o ciclo diário com administrador e gestor distintos: cadastros, preços, metas, regras, lançamentos, aprovações independentes, fechamento, relatórios, exportações, snapshot, reabertura, auditoria e logout. O Playwright visual cobre todas as rotas do preview em desktop e celular.
- Inicialização de produção rejeita JWT/banco fracos, ausentes ou placeholders; Docker Compose não possui credencial operacional conhecida como fallback.
- Os workflows de CI estão configurados para aplicar migrations em PostgreSQL limpo, confirmar bootstrap sem dados operacionais, bloquear vulnerabilidades altas/críticas, executar lint, typecheck, Vitest, Playwright demonstrativo e operacional, provar restauração em banco separado, construir imagens fixadas por digest e testar login/RBAC pelo proxy dos containers de produção. Cada commit ainda precisa terminar esse pipeline verde antes de ser promovido.

## Limites atuais

- O arquivo original `Relatórios -MAIO-JUNHO 2026.xlsx` não está disponível no workspace atual. A reconciliação final célula a célula não pode ser repetida nem certificada até o arquivo ser anexado novamente.
- A fonte Excel ainda não fornece linhagem independente célula/fórmula para todos os produtos e lançamentos de produção; `sourceIntegrity.independentDerivedMetrics=false` bloqueia certificação do lote atual.
- A fórmula P1 de rendimento esperado diverge do cálculo anterior do backend, e há rendimentos acima de 100%. Nenhuma decisão foi presumida; homologação operacional continua obrigatória.
- Perdas da planilha não identificam setor nem produto. Esses campos precisam de correção humana e preço aprovado vigente antes de promoção.
- Dosagem órfã e arquivo morto estão preservados, mas não alimentam tabelas oficiais até existir reconciliação histórica/contexto operacional suficiente.
- Empresas/unidades, equipes, ordens de produção e alguns drill-downs gerenciais ainda não possuem ciclo administrativo completo equivalente aos módulos principais.
- A prova automatizada de restauração existe, mas cada ambiente real ainda precisa definir RPO/RTO, armazenamento externo, monitoramento e calendário de exercícios.
- O fluxo mestre de negócio possui E2E real em API, mas ainda falta automatizar no navegador o preenchimento e a decisão de cada formulário operacional contra os containers de produção.
- O bootstrap intencionalmente cria apenas um ADMIN. Antes da operação, esse administrador precisa cadastrar e testar um segundo gestor/supervisor ativo; a segregação bloqueia autoaprovação de lançamentos, preços e metas.
- Nenhum host operacional, domínio, certificado TLS, PostgreSQL gerenciado ou destino externo de backup foi fornecido nesta sessão. GitHub Pages continua sendo somente demonstração estática.
- A fórmula P1, limites de classificação de parada e ranking de sobrepeso permanecem bloqueados para decisão humana quando marcados como `REVIEW_REQUIRED`.
- `npm audit` não aponta vulnerabilidade alta/crítica; restam dois achados moderados na cadeia transitiva ExcelJS/UUID, sem correção compatível publicada no lock atual.

## Regra de uso

- Homologacao com dados controlados: permitida.
- Operacao paralela ao Excel: permitida com backup e supervisao.
- Substituicao integral do Excel: nao liberada.
- GitHub Pages: apenas preview demonstrativo, nunca dados reais.
- Producao: API, PostgreSQL, segredos fortes, HTTPS, backup e monitoramento obrigatorios.

## Criterios para substituir a planilha

1. Reconciliar totais e registros de todas as abas relevantes entre Excel e PostgreSQL.
2. Homologar fórmulas, limites, relatórios e regras `REVIEW_REQUIRED` com os responsáveis operacionais.
3. Provisionar domínio/HTTPS, PostgreSQL, segredos, armazenamento externo de backup e monitoramento no ambiente escolhido.
4. Executar o pipeline e a prova de restauração nesse ambiente, registrando RPO/RTO.
5. Executar operação paralela por período acordado, sem divergências não explicadas.
6. Obter aceite humano formal antes de desligar a planilha.

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

Consulte tambem [`go-live-readiness-2026-08-01.md`](go-live-readiness-2026-08-01.md), [`audit-resolution-2026-07-18.md`](audit-resolution-2026-07-18.md), [`production-deploy.md`](production-deploy.md) e [`security-and-import.md`](security-and-import.md).
