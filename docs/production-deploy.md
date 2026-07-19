# Deploy de producao

Este projeto suporta dois modelos de publicacao:

- Frontend estatico no GitHub Pages.
- Aplicacao completa em Docker Compose, com Web, API, PostgreSQL e volume de backups.

## GitHub Pages

O workflow `.github/workflows/pages.yml` publica somente a demonstracao sem dados reais. Ele pode ser acionado manualmente e atualiza automaticamente em `main` e na branch de homologacao `agent/corrige-auditoria-operacional`.

Etapas executadas no CI:

- `npm ci`
- `npm run prisma:generate`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `NEXUS_STATIC_DEMO=true NEXT_PUBLIC_DEMO_MODE=true npm run build` em `apps/web`
- upload de `apps/web/out`

URL esperada:

```text
https://rafaelrfl0900-ship-it.github.io/nexus-operacional/
```

Esse modo publica somente o frontend e nao e o deploy operacional. Para login real, importacao, backups e banco de dados, use o deploy completo protegido com API e PostgreSQL.

O login do Pages (`admin@demo.nexus.local` / `NexusDemo@2026`) e deliberadamente publico e existe apenas dentro do bundle estatico. Ele nunca deve ser reutilizado no seed, no PostgreSQL ou em qualquer ambiente operacional.

## Docker Compose completo

1. Crie um `.env` a partir de `.env.example`.
2. Troque os segredos antes de usar em producao:

- `POSTGRES_PASSWORD`
- `JWT_ACCESS_SECRET`
- `WEB_ORIGIN`
- `DATABASE_URL`
- `BACKUP_DIR`
- `IMPORT_UPLOAD_DIR`

3. Suba os servicos:

```bash
docker compose up -d --build
```

4. Aplique migrations e seed:

```bash
docker compose exec api npx prisma migrate deploy
docker compose exec api npm run prisma:seed
```

## URLs

- Web operacional: `http://localhost:3000/`
- API pelo navegador: `http://localhost:3000/api`
- API direta interna/local: `http://localhost:3333/api`
- Health API publico minimo: `http://localhost:3000/api/health`
- Health Web: `http://localhost:3000/login`

O frontend operacional usa `/api` por padrao. No Docker Compose, o servidor standalone do Next.js reescreve esse caminho para `API_INTERNAL_URL` (por padrao, `http://api:3333`), preservando cookies HTTP-only de mesma origem. Assim o navegador de outro computador da rede nao tenta chamar `localhost:3333`.

Cada JWT de acesso inclui a versao de sessao do usuario. A API consulta o usuario e seus papeis atuais no PostgreSQL em toda rota protegida; desativacao, exclusao, troca de papeis, redefinicao de senha ou revogacao administrativa invalidam imediatamente todos os tokens anteriores. Este projeto nao usa refresh token.

O container operacional executa `apps/web/server.js` gerado por `output: "standalone"` e copia os artefatos `.next/static` e `public`. A pasta `apps/web/out` existe somente no build demonstrativo com `NEXUS_STATIC_DEMO=true` e nao participa do deploy Docker.

## Importacao XLSX

O endpoint operacional de importacao aceita somente upload multipart em `/api/import/upload`. O navegador nao informa caminho de arquivo do servidor. A API valida extensao, MIME type, assinatura ZIP do XLSX e tamanho, calcula SHA-256, armazena o arquivo no volume privado `nexus-imports` e cria um lote de importacao auditavel.

O container da API inclui Python 3 e copia a pasta `scripts/`, pois o importador legado ainda executa `scripts/import_excel.py` de forma controlada no backend.

O inspetor valida a estrutura XLSX antes do parser, ambos executam em copia temporaria isolada com timeout e limites de memoria/saida, e arquivos suspeitos sao rejeitados antes de criar o lote.

## Backups

O Compose monta o volume `nexus-backups` em `/app/backups` na API. O endpoint usa `BACKUP_DIR` e registra tamanho e checksum. A captura le todas as tabelas em uma transacao `REPEATABLE READ`; diretorio e arquivo recebem permissoes `0700`/`0600`, e o container da API executa como usuario `node`, nao root.

Com `BACKUP_SCHEDULE_ENABLED=true`, um snapshot e criado diariamente as 02:00 e a retencao mantem `BACKUP_RETENTION_COUNT`. `POST /api/backups/:id/restore-rehearsal` valida checksum, formato, tipos e contagens em tabelas temporarias sem alterar dados reais. Antes da liberacao de producao, ainda e obrigatorio ensaiar uma restauracao real em PostgreSQL separado e documentar RPO/RTO.

## Dominio

Para usar dominio proprio, coloque um proxy reverso como Caddy, Nginx ou Traefik na frente dos servicos:

- Direcione o frontend para o container `web` na porta `3000`.
- Exponha a API ao navegador preferencialmente por `/api` no mesmo dominio do frontend.
- Configure `WEB_ORIGIN` com a origem publica do frontend.
- Evite compilar o frontend com URL absoluta de API; mantenha `NEXT_PUBLIC_API_URL=/api`.
