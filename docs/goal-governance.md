# Governança de metas

## Fonte operacional

Dashboard e snapshots usam somente metas `APPROVED` cuja vigência intersecta o período consultado. Registros `DRAFT`, `RETIRED` e legados incompletos nunca controlam indicador.

Metas antigas migradas por `0017_goal_governance` permanecem `DRAFT`. Migração não inventa unidade, vigência, responsável nem aprovação. Para utilizá-las, gestor cria nova versão com metadados reais e depois aprova.

## Workflow

- `DRAFT`: versão criada, ainda sem efeito operacional.
- `APPROVED`: versão vigente e elegível para dashboard.
- `RETIRED`: versão preservada apenas para histórico.

Definição de uma versão é imutável no serviço e por trigger PostgreSQL. Mudança de nome, alvo, comparador, unidade, frequência, vigência ou responsável exige `POST /goals/:id/versions`. Métrica e escopo identificam a série e não mudam entre versões.

Ao aprovar nova versão, versão aprovada anterior da mesma série é retirada na mesma transação. Auditoria também é gravada nessa transação.

## Vigência e escopo

Escopo pode combinar setor, linha, equipamento, turno e produto. API valida vínculos entre setor, linha e equipamento. PostgreSQL usa exclusão GiST para impedir sobreposição entre metas `APPROVED` da mesma métrica e escopo, inclusive sob concorrência.

Produto não pode compor meta de `downtime_minutes`, pois parada não possui vínculo de produto.

## API

- `GET /goals`: lista versões; aceita `weekId`, `status`, `metric` e `seriesId`.
- `GET /goals/references`: catálogos seguros para formulário.
- `GET /goals/series/:seriesId`: histórico imutável.
- `POST /goals`: cria série em `DRAFT`.
- `POST /goals/:id/versions`: cria nova versão em `DRAFT`.
- `POST /goals/:id/approve`: aprova com motivo obrigatório.
- `POST /goals/:id/retire`: retira com motivo obrigatório.

Criação, versão, aprovação e retirada exigem `ADMIN` ou `MANAGER`. Consulta também aceita `SUPERVISOR` e `VIEWER`.

Valores alvo usam `Prisma.Decimal` e coluna `Decimal(14,6)`. Nenhum alvo é criado pelo seed ou pré-preenchido no frontend.
