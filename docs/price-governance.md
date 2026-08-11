# Governança de preços

Cada preço é uma versão imutável de `ProductPricePeriod`. Alterar valor, moeda, origem, observação ou vigência exige novo registro.

## Workflow

1. `POST /products/:productId/prices` cria `DRAFT` e identifica usuário responsável.
2. `POST /products/:productId/prices/:priceId/approve` exige `ADMIN` ou `MANAGER`, `recordVersion`, motivo e aprovador diferente do responsável.
3. `POST /products/:productId/prices/:priceId/retire` aposenta rascunho ou preço aprovado, sem apagar histórico.

Períodos `APPROVED` do mesmo produto não podem se sobrepor. Rascunhos e versões aposentadas podem coexistir no mesmo intervalo para que evidência legada não bloqueie a criação de uma substituição governada; somente um preço aprovado é fonte financeira. `version` identifica versão de negócio e nunca muda. `recordVersion` controla concorrência nas transições.

## Legado

Migration `0018_product_price_governance` mantém valor e vigência existentes, atribui versão técnica determinística e deixa registros em `DRAFT`. Moeda, origem, responsável e aprovação ficam vazios: nenhum dado humano é presumido. Para uso operacional, crie e aprove novo registro completo.

## Cálculos e histórico

Produção e perdas consultam somente preço `APPROVED` vigente na data do lançamento. Ausência bloqueia cálculo; campos antigos de preço no produto não servem como fallback.

Cada lançamento novo grava:

- `pricePeriodId`;
- `priceVersion`;
- `priceOrigin`;
- `priceCurrency`;
- valor monetário efetivamente usado;
- versões das regras de cálculo.

Mudança ou aposentadoria futura não recalcula lançamentos antigos. Semanas fechadas continuam imutáveis pelas regras do ciclo semanal.

## Importação XLSX

Preço encontrado na planilha permanece evidência de staging; ele não atualiza `Product.pricePerKg` e não cria aprovação automática. Produção importada exige um `ProductPricePeriod` `APPROVED` vigente na data e grava toda a linhagem acima. Perda de filme também exige produto identificado e `filmCostPerKg` positivo no período aprovado. Se produto, vigência, moeda, origem ou aprovação faltarem, a promoção transacional do lote é bloqueada e revertida.
