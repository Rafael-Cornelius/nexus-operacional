# Linha de base de reconciliação — Excel × Nexus

Data da análise: 18/07/2026
Arquivo: `Relatórios -MAIO-JUNHO 2026.xlsx`
Tamanho: 1.084.386 bytes
SHA-256: `7ba9e6c1a14091033fcf22a74c1b9d208da0719b27f0125d035e17b1a3f1f5fb`

## Estrutura encontrada

| Item | Resultado bruto |
| --- | ---: |
| Abas | 26 |
| Fórmulas | 16.980 |
| Tabelas | 25 |
| Gráficos | 86 |
| Erros `#REF!` | 1.454 |
| Produtos normalizados | 87 |
| Erros de produto | 127 |
| Códigos de peso duplicados | 4 |

Códigos de peso duplicados: `70974`, `73735`, `76379` e `76678`.

## Dados operacionais extraídos

| Domínio | Linhas | Intervalo observado | Totais brutos relevantes |
| --- | ---: | --- | --- |
| Produção | 199 | 05/04/2026 a 05/11/2026 | 95.099 lotes planejados; 67.028 realizados; 53.693 caixas; 1.702,977 kg de perda de pesagem |
| Produção P1 | 169 | incluído acima | 1.291 planejados; 1.161 realizados; 48.694 caixas; 1.665,757 kg de perda |
| Produção P2 | 30 | incluído acima | 93.808 planejados; 65.867 realizados; 4.999 caixas; 37,220 kg de perda |
| Reprocesso usado | — | — | 4.970,500 kg |
| Reprocesso gerado | — | — | 715,928 kg |
| Perdas registradas | 93 | 27/04/2026 a 14/07/2026 | 640,255 kg |
| Paradas | 360 | 01/06/2026 a 14/07/2026 | 14.507 minutos calculados |

Na leitura bruta, o inspetor anterior registrava apenas seis erros operacionais de mapeamento. O hardening atual tambem coloca fora do fluxo elegivel todas as linhas fora do periodo declarado no nome e a anomalia de OP em “planejado”. O resultado seguro passa a ser:

| Dominio | Bruto | Elegivel para pre-processamento/importacao | Inconsistencias operacionais totais |
| --- | ---: | ---: | ---: |
| Producao | 199 | 161 | incluido abaixo |
| Perdas | 93 | 68 | incluido abaixo |
| Paradas | 360 | 240 | incluido abaixo |
| Total de inconsistencias operacionais | — | — | 189 |

Essas 189 inconsistencias se somam as 127 inconsistencias de produto. “Elegivel” nao significa aprovado: todos os registros importados continuam como rascunho e o lote nao pode ser certificado enquanto existir erro pendente.

## Alertas que impedem certificação automática

- O nome do arquivo indica maio–junho, mas existem datas interpretadas até novembro de 2026.
- Os totais de lotes P2 (`93.808` planejados e `65.867` realizados) são desproporcionais em relação às 30 linhas encontradas e exigem validação célula a célula.
- Existem 1.454 fórmulas com `#REF!`; resultados derivados dessas fórmulas não podem ser tratados como fonte confiável sem reparo.
- Quatro códigos possuem configuração de peso duplicada.
- Há 127 inconsistências na normalização dos produtos e seis inconsistências operacionais adicionais.

### Evidências localizadas na origem

| Célula | Valor bruto | Interpretação/risco |
| --- | ---: | --- |
| `Plan x Real (P2)!C3` | `46117` | Serial de data correspondente a `05/04/2026`. A célula usa o formato interno `14`, cuja apresentação é dependente da localidade. |
| `Plan x Real (P2)!C11` | `46331` | Serial de data correspondente a `05/11/2026`. Pelo período declarado no arquivo, precisa de confirmação humana antes da importação. |
| `Plan x Real (P2)!F54` | `23478` | A coluna F é “Planejado (bateladas)”, mas a célula contém um número semelhante a uma ordem de produção. Na mesma linha, `E54` contém OP `23469` e `G54` contém realizado `2`; o indício é de cópia ou deslocamento de coluna. |

Os seriais acima foram conferidos diretamente no XML do XLSX, não são uma conversão inventada pelo importador. Por isso, o sistema deve colocar essas linhas em revisão e nunca corrigi-las silenciosamente.

## Regra de aceite implementada

Cada novo lote passa a guardar vínculo explícito nos registros importados. O endpoint:

`GET /api/import/:batchId/reconciliation`

compara, para o mesmo lote:

- quantidade de lançamentos de produção;
- produção em kg;
- perda de pesagem em kg;
- sobrepeso em kg;
- quantidade e kg de perdas registradas;
- quantidade e minutos de paradas.

O lote só recebe `certified: true` quando todas as diferenças ficam dentro da tolerância configurada e não existe erro pendente. Lotes antigos, sem totais de origem, precisam ser reprocessados pelo inspetor atual.

## Estado desta linha de base

Esta leitura é uma linha de base bruta, não um termo de aceite. A certificação operacional depende da correção das datas e dos valores de P2, da resolução dos produtos/configurações duplicados e da comparação do lote efetivamente gravado no PostgreSQL.
