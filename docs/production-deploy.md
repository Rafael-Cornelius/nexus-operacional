# Deploy de producao

Este projeto suporta dois modelos de publicacao:

- Frontend estatico no GitHub Pages.
- Aplicacao completa em Docker Compose, com Web, API, PostgreSQL e volume de backups.

## GitHub Pages

O workflow `.github/workflows/pages.yml` ficou restrito a acionamento manual e deve ser usado somente como demonstracao publica sem dados reais.

Etapas executadas no CI:

- `npm install`
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

## Docker Compose completo

1. Crie um `.env` a partir de `.env.example`.
2. Troque os segredos antes de usar em producao:

- `POSTGRES_PASSWORD`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
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

- Web: `http://localhost:3000/nexus-operacional/`
- API pelo navegador: `http://localhost:3000/api`
- API direta interna/local: `http://localhost:3333/api`
- Health API publico minimo: `http://localhost:3000/api/health`
- Health Web: `http://localhost:3000/health`

O frontend operacional usa `/api` por padrao. No Docker Compose, o Nginx do container web faz proxy desse caminho para `api:3333/api`, preservando cookies HTTP-only de mesma origem. Assim o navegador de outro computador da rede nao tenta chamar `localhost:3333`.

## Importacao XLSX

O endpoint operacional de importacao aceita somente upload multipart em `/api/import/upload`. O navegador nao informa caminho de arquivo do servidor. A API valida extensao, MIME type, assinatura ZIP do XLSX e tamanho, calcula SHA-256, armazena o arquivo no volume privado `nexus-imports` e cria um lote de importacao auditavel.

O container da API inclui Python 3 e copia a pasta `scripts/`, pois o importador legado ainda executa `scripts/import_excel.py` de forma controlada no backend.

## Backups

O Compose monta o volume `nexus-backups` em `/app/backups` na API. O endpoint de backups usa `BACKUP_DIR` e registra cada snapshot na tabela `backups`, com tamanho e checksum.

## Dominio

Para usar dominio proprio, coloque um proxy reverso como Caddy, Nginx ou Traefik na frente dos servicos:

- Direcione o frontend para o container `web` na porta `3000`.
- Exponha a API ao navegador preferencialmente por `/api` no mesmo dominio do frontend.
- Configure `WEB_ORIGIN` com a origem publica do frontend.
- Evite compilar o frontend com URL absoluta de API; mantenha `NEXT_PUBLIC_API_URL=/api`.
