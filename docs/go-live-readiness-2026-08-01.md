# Gate de go-live — 2026-08-01

Revalidado tecnicamente em 2026-08-10; a decisão permanece inalterada.

## Decisão

**NÃO LIBERADO para substituir o Excel como fonte oficial ou para operação diária exclusiva.**

O código está apto a continuar em homologação controlada e operação paralela supervisionada. GitHub Pages permanece somente demonstração sem dados reais.

## Controles concluídos nesta etapa

- Bootstrap não destrutivo, sem catálogo nem lançamentos fictícios, com prova que percorre todas as tabelas antes do primeiro uso.
- Cadastros-base de setores, linhas, tipos de perda e motivos de parada.
- Equipamentos e turnos vinculados aos formulários operacionais.
- Workflow versionado e auditado para produção, perdas, paradas, dosagem e produtividade.
- Governança humana das regras de cálculo ambíguas; aprovações dependentes falham de forma fechada.
- FKs dos 25 campos de ator dos cinco workflows, sem quebrar upgrades que contenham órfãos históricos.
- Migration de dosagem/produtividade compatível com semanas históricas fechadas, com prova específica de upgrade.
- Login e mutações de usuários com alteração e auditoria na mesma transação.
- Health real do PostgreSQL, fluxo mestre E2E em API e smoke de login/RBAC dos containers configurados no pipeline.
- Backup PostgreSQL nativo cifrado e prova de restauração em banco vazio separado (a confirmação final depende do pipeline com PostgreSQL).
- Actions fixadas por commit, auditoria de dependências sem achados altos/críticos e preview visual desktop/mobile.

## P0 — bloqueios absolutos

1. **Infraestrutura operacional ausente.** Não foram fornecidos host, domínio, TLS, PostgreSQL operacional, armazenamento externo, monitoramento ou segredos de deploy. O `.env` local não possui as configurações exigidas pelo Compose.
2. **Certificação Excel × banco bloqueada.** O arquivo `Relatórios -MAIO-JUNHO 2026.xlsx` não está disponível no workspace. Além disso, os lotes atuais declaram `independentDerivedMetrics=false` e `completeReconciliationScope=false`; o backend recusa certificá-los corretamente.
3. **Fórmulas sem aceite humano.** A divergência do rendimento P1 e outras regras `REVIEW_REQUIRED` não podem ser aprovadas automaticamente. A decisão exige responsável operacional, evidência e justificativa auditada.

## P1 — equivalência funcional ainda incompleta

- Importação não promove ainda todos os domínios exigidos: preços, metas, produtividade e sobrepeso histórico completo.
- Troca obrigatória da senha inicial ainda não possui fluxo dedicado.
- Hierarquia Empresa → Unidade → Setor → Linha → Equipamento e equipes/centros de trabalho ainda é parcial.
- Ordem de Produção não possui módulo administrativo completo nem todos os campos industriais do Prompt Mestre.
- Produtividade automática ainda não desconta integralmente paradas, intervalos e tempo não produtivo por recurso.
- Dosagem/sobrepeso ainda não cobre toda rastreabilidade, conformidade, ação corretiva e custo pedidos.
- Perdas e paradas ainda não possuem hierarquia causal completa, ações corretivas, anexos/comentários e operações de dividir/unir parada.
- Falta E2E de navegador cobrindo o preenchimento e a decisão de todos os formulários contra as imagens de produção; hoje o fluxo mestre profundo é exercitado em API.

## Uso permitido

- Preview demonstrativo: permitido.
- Homologação com dados controlados: permitida.
- Operação paralela ao Excel: permitida com supervisão, backup e reconciliação diária.
- Desligar o Excel ou usar o Nexus como fonte oficial exclusiva: proibido até fechar todos os P0, homologar os P1 necessários e obter aceite formal.

## Evidência exigida para mudar a decisão

1. Reanexar a planilha original e concluir a matriz aba/célula/fórmula → banco/relatório.
2. Aprovar ou substituir cada regra `REVIEW_REQUIRED` com responsável e justificativa.
3. Provisionar ambiente privado com HTTPS, PostgreSQL, segredos, backup externo e monitoramento.
4. Executar migrations, E2E operacional, smoke dos containers e restauração nesse ambiente.
5. Cadastrar e testar um segundo gestor/supervisor ativo para segregação de funções; o ADMIN inicial não pode autoaprovar.
6. Reconciliar totais por pelo menos duas semanas de operação paralela.
7. Obter aceite formal do responsável pela produção.
