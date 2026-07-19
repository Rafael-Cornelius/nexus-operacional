# Segurança de dependências — 18/07/2026

## Resultado

O `npm audit` inicial reportava nove vulnerabilidades:

- 1 crítica;
- 3 altas;
- 4 moderadas;
- 1 baixa.

Após atualizações compatíveis e revisão do lockfile:

- 0 críticas;
- 0 altas;
- 2 moderadas;
- 0 baixas.

Foram corrigidas as cadeias relacionadas a Vitest/Vite, ECharts, NestJS/Multer, esbuild e js-yaml. O CI executa `npm audit --audit-level=high`, bloqueando imediatamente qualquer vulnerabilidade alta ou crítica.

## Alertas moderados residuais

Os dois registros residuais representam a mesma dependência transitiva:

`next@15.5.20 -> postcss@8.4.31`

O aviso é o `GHSA-qx2v-qp2m-jg93`, relativo à serialização de CSS contendo `</style>`. O projeto fixa `postcss@8.5.19` para suas dependências diretas, mas o Next mantém sua própria versão exata interna.

Na data desta revisão, o próprio `npm audit fix` não oferece uma atualização compatível. A única sugestão automática é forçar downgrade para `next@9.3.3`, o que é uma mudança incompatível e insegura para esta aplicação. Por isso, `npm audit fix --force` foi deliberadamente rejeitado.

## Mitigação

- Nenhum CSS fornecido por usuário é compilado ou serializado pelo servidor.
- Uploads aceitam somente XLSX estruturalmente validado; conteúdo enviado não entra no pipeline CSS.
- Builds são executados em CI isolado.
- Alertas altos e críticos bloqueiam a publicação.
- Next e PostCSS devem ser revistos assim que houver versão do Next que atualize a dependência transitiva sem downgrade.

## Comandos de verificação

```bash
npm audit
npm audit --audit-level=high
npm ls next postcss
```
