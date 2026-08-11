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
- `npm run test:e2e` em Chromium antes da publicação
- `NEXUS_STATIC_DEMO=true NEXT_PUBLIC_DEMO_MODE=true npm run build` em `apps/web`
- `npm run test:e2e:pages` servindo o `apps/web/out` real sob `/nexus-operacional/`
- upload de `apps/web/out`

URL esperada:

```text
https://rafaelrfl0900-ship-it.github.io/nexus-operacional/
```

Esse modo publica somente o frontend e nao e o deploy operacional. Para login real, importacao, backups e banco de dados, use o deploy completo protegido com API e PostgreSQL.

O login do Pages (`admin@demo.nexus.local` / `NexusDemo@2026`) e deliberadamente publico e existe apenas dentro do bundle estatico. Ele nunca deve ser reutilizado no seed, no PostgreSQL ou em qualquer ambiente operacional.

## Docker Compose completo

O host precisa de Docker Engine, Docker Compose v2, `curl`, `jq` e `openssl`.
As imagens oficiais Node/PostgreSQL usam tag legível mais digest imutável. Toda
renovação de digest deve ocorrer em PR próprio, com o pipeline completo verde;
não remova o digest para buscar uma imagem flutuante diretamente em produção.

1. Crie um `.env` a partir de `.env.example`.
2. Gere segredos independentes. Nao copie os valores do ambiente de demonstracao e nao reutilize uma chave para duas finalidades:

```bash
openssl rand -hex 32
openssl rand -base64 48
openssl rand -base64 32
```

Use, respectivamente, as saidas em `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET` e `BACKUP_ENCRYPTION_KEY`. O valor hexadecimal do PostgreSQL evita caracteres que precisariam de escape dentro da URL.

3. Preencha as demais configuracoes antes de usar em producao:

- `POSTGRES_PASSWORD`
- `JWT_ACCESS_SECRET`
- `INITIAL_ADMIN_EMAIL`
- `INITIAL_ADMIN_PASSWORD` (minimo 12 caracteres, maiuscula, minuscula, numero e simbolo; exclusiva deste ambiente)
- `WEB_ORIGIN`
- `BACKUP_ENCRYPTION_KEY` (32 bytes em base64 ou 64 caracteres hexadecimais)
- `BACKUP_EXTERNAL_HOST_DIR` apontando para um bind mount protegido em disco/NAS distinto
- `.env.restore` separado, modo `0600`, com `RESTORE_DATABASE_URL` apontando somente para o banco descartavel `nexus_restore_proof`

O Compose monta `DATABASE_URL` internamente com `POSTGRES_USER`, `POSTGRES_PASSWORD` e `POSTGRES_DB`. Em deploy direto da API, fora do Compose, defina uma `DATABASE_URL` PostgreSQL completa e codifique caracteres especiais da senha para URL. Credenciais publicas do preview sao recusadas pela politica do bootstrap.

`POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `WEB_ORIGIN`, `BACKUP_ENCRYPTION_KEY` e o caminho externo usam a expansao obrigatoria `${VAR:?mensagem}`. Ausencia ou valor vazio interrompe `docker compose config/up` antes da criacao dos containers; nao existe segredo conhecido como fallback. A API faz uma segunda barreira ao iniciar com `NODE_ENV=production`: exige JWT, senha da `DATABASE_URL`, origem Web e chave de backup validas, rejeitando valores previsiveis como `change-this`, `replace-with`, `placeholder`, `example` ou segredos repetitivos. `WEB_ORIGIN` deve ser HTTPS fora de loopback e o cookie aceita somente `SameSite=Lax` ou `Strict`. A mensagem de erro identifica somente a variavel, nunca revela o segredo.

4. Prepare o destino externo antes de validar o Compose. O caminho deve existir,
pertencer ao UID/GID `1000:1000` usado pelo container da API e estar em
armazenamento diferente do volume PostgreSQL:

```bash
sudo install -d -m 0700 -o 1000 -g 1000 /mnt/nexus-backups
```

Defina `BACKUP_EXTERNAL_HOST_DIR=/mnt/nexus-backups`. Um diretório no mesmo
disco do banco não atende o requisito de recuperação de desastre.

## Primeiro deploy — banco novo

Construa as imagens e suba somente o PostgreSQL:

```bash
docker compose build api web
docker compose stop web api
docker compose up -d postgres
```

5. Aplique migrations e bootstrap operacional limpo em containers descartáveis; somente depois suba API e Web:

```bash
cp .env.bootstrap.example .env.bootstrap
chmod 0600 .env.bootstrap
# preencha os cinco campos; COMPANY_NAME pode ficar vazio
```

```bash
docker compose run --rm api npm run prisma:deploy
docker compose run --rm --env-from-file .env.bootstrap api npm run prisma:seed
docker compose run --rm --env-from-file .env.bootstrap api npm run bootstrap:assert-clean
```

Essa ordem impede que uma versão nova da API atenda requisições sobre um schema antigo. Em primeiro deploy, `docker compose stop web api` pode apenas informar que ainda não existem containers.

Crie `.env.bootstrap` com permissao `0600` contendo somente `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD`, `INITIAL_ADMIN_NAME`, `INITIAL_ADMIN_ROTATE_PASSWORD` e, opcionalmente, `COMPANY_NAME`. O arquivo e ignorado pelo Git. `prisma:seed` sincroniza somente permissoes/RBAC, cria o administrador informado e, quando `COMPANY_NAME` foi preenchido, grava esse nome. Nao cria produto, meta, semana, producao, perda, parada, equipamento, turno ou historico. Pode ser repetido sem `INITIAL_ADMIN_PASSWORD` quando o administrador ja existe: a senha permanece intacta. Para rotacao intencional, preencha uma nova senha e execute uma unica vez com `INITIAL_ADMIN_ROTATE_PASSWORD=true`; a versao de sessao aumenta e tokens anteriores deixam de valer. Depois apague a senha de `.env.bootstrap` e retorne a variavel para `false`. As variaveis de bootstrap entram somente no container descartavel do seed e nao permanecem no container da API.

Dados de demonstracao ficam isolados em `prisma/seed-demo.ts`. Script recusa `NODE_ENV=production` e exige `ALLOW_DEMO_SEED=true`; nunca execute em banco operacional.

O seed nunca apaga dados. Para começar do zero, use banco e volume novos. Não use `docker compose down -v` em um ambiente que possa conter dados reais. `bootstrap:assert-clean` verifica todas as tabelas e aborta se encontrar qualquer cadastro, lançamento, importação, auditoria, relatório, snapshot ou backup; permite apenas RBAC, um administrador ativo e a configuração opcional `company`. Execute essa prova somente no primeiro deploy vazio; ela deve falhar em um ambiente que já entrou em operação.

6. Antes de iniciar Web/API, prove o backup primario, a copia externa e uma restauracao real. Copie `.env.restore.example` para `.env.restore`, aplique permissao `0600` e preencha somente `RESTORE_DATABASE_URL`, usando credencial URL-encoded e o nome exato `nexus_restore_proof`; nunca use o banco operacional como destino:

```bash
docker compose exec -T postgres sh -ec 'createdb -U "$POSTGRES_USER" nexus_restore_proof'
backup_json="$(docker compose run --rm -T api npm run --silent backup:create:snapshot)"
backup_path="$(printf '%s' "$backup_json" | jq -er '.filePath')"
backup_sha256="$(printf '%s' "$backup_json" | jq -er '.checksum')"
backup_name="$(basename "$backup_path")"

docker compose run --rm -T \
  -e EXPECTED_BACKUP_SHA256="$backup_sha256" \
  -e EXTERNAL_BACKUP_PATH="/app/backups-external/$backup_name" \
  api sh -ec 'test -s "$EXTERNAL_BACKUP_PATH"; printf "%s  %s\n" "$EXPECTED_BACKUP_SHA256" "$EXTERNAL_BACKUP_PATH" | sha256sum -c'

docker compose run --rm -T --env-from-file .env.restore \
  -e RESTORE_DATABASE_EXPECTED_NAME=nexus_restore_proof \
  -e RESTORE_CONFIRMATION=RESTORE_TO_EMPTY_DATABASE:nexus_restore_proof \
  -e RESTORE_BACKUP_SHA256="$backup_sha256" \
  api npm run backup:restore:prove -- --file "$backup_path"

docker compose up -d --wait --wait-timeout 180 api web
```

Preserve a saida `RESTORE_PROOF_PASSED` e o checksum fora do host. Guarde a senha inicial no gerenciador de senhas e apague `INITIAL_ADMIN_PASSWORD` de `.env.bootstrap` depois do primeiro acesso confirmado.

7. Antes de qualquer lançamento, crie e teste um segundo usuario ativo `MANAGER` ou `SUPERVISOR`. O administrador inicial nao pode aprovar o proprio envio, preco ou meta; sem segregacao real o ciclo operacional nao fecha. Depois acesse `/configuracoes` como ADMIN e registre a decisão humana das regras marcadas como `REVIEW_REQUIRED`. O sistema bloqueia a aprovação de lançamentos dependentes até essa decisão; o deploy não presume fórmulas ambíguas.

## Atualização — banco com dados

Nunca execute `bootstrap:assert-clean` em atualização. Faça esta etapa antes de
trocar o checkout, puxar codigo ou construir imagens novas. Pare Web/API e use a
imagem atualmente implantada para criar e provar o backup; assim o backup nao
depende de codigo/Prisma ainda incompatível com o schema antigo:

```bash
docker compose stop web api
docker compose up -d --wait postgres

backup_json="$(docker compose run --rm -T api npm run --silent backup:create:snapshot)"
backup_path="$(printf '%s' "$backup_json" | jq -er '.filePath')"
backup_sha256="$(printf '%s' "$backup_json" | jq -er '.checksum')"
backup_name="$(basename "$backup_path")"

docker compose exec -T postgres sh -ec 'createdb -U "$POSTGRES_USER" nexus_restore_proof'
docker compose run --rm -T \
  -e EXPECTED_BACKUP_SHA256="$backup_sha256" \
  -e EXTERNAL_BACKUP_PATH="/app/backups-external/$backup_name" \
  api sh -ec 'test -s "$EXTERNAL_BACKUP_PATH"; printf "%s  %s\n" "$EXPECTED_BACKUP_SHA256" "$EXTERNAL_BACKUP_PATH" | sha256sum -c'
docker compose run --rm -T --env-from-file .env.restore \
  -e RESTORE_DATABASE_EXPECTED_NAME=nexus_restore_proof \
  -e RESTORE_CONFIRMATION=RESTORE_TO_EMPTY_DATABASE:nexus_restore_proof \
  -e RESTORE_BACKUP_SHA256="$backup_sha256" \
  api npm run backup:restore:prove -- --file "$backup_path"

current_api_image="$(docker compose images -q api)"
current_web_image="$(docker compose images -q web)"
test -n "$current_api_image" && test -n "$current_web_image"
docker image tag "$current_api_image" nexus-operacional-api:rollback-preupgrade
docker image tag "$current_web_image" nexus-operacional-web:rollback-preupgrade
```

Guarde a saída `RESTORE_PROOF_PASSED` fora do host. Só então selecione o commit
aprovado, construa imagens novas, aplique migration, sincronize RBAC e volte a
atender tráfego. Defina `NEXUS_RELEASE_COMMIT` com o SHA completo aprovado pelo
pipeline, nunca com nome flutuante de branch:

```bash
git fetch --tags origin
test -n "${NEXUS_RELEASE_COMMIT:-}"
git checkout "$NEXUS_RELEASE_COMMIT"
docker compose build api web
docker compose run --rm -T api npm run prisma:deploy
docker compose run --rm -T --env-from-file .env.bootstrap api npm run prisma:seed
docker compose up -d --wait --wait-timeout 180 api web
curl --fail --retry 12 --retry-connrefused --retry-delay 5 http://127.0.0.1:3000/api/health
```

O banco `nexus_restore_proof` é descartável e nunca vira produção. Remova-o
somente depois de preservar a evidência e confirmar o nome exato pelo processo
controlado do provedor.

## URLs

- Web operacional: `http://localhost:3000/`
- API pelo navegador: `http://localhost:3000/api`
- API direta interna/local: `http://localhost:3333/api`
- Health API publico minimo: `http://localhost:3000/api/health`
- Health Web: `http://localhost:3000/login`

`API_HOST_PORT` altera somente a porta loopback publicada no host (3333 por
padrao). A API dentro do Compose permanece em 3333, portanto healthcheck e
`API_INTERNAL_URL=http://api:3333` continuam coerentes.

O frontend operacional usa `/api` por padrao. No Docker Compose, o servidor standalone do Next.js reescreve esse caminho para `API_INTERNAL_URL` (por padrao, `http://api:3333`), preservando cookies HTTP-only de mesma origem. Assim o navegador de outro computador da rede nao tenta chamar `localhost:3333`.

`API_INTERNAL_URL` e `NEXT_PUBLIC_API_URL` sao argumentos de build do frontend,
nao configuracoes dinamicas da imagem pronta. Depois de alterar qualquer uma,
execute `docker compose build web` antes de recriar o servico. O Compose fixa
`BACKUP_DIR=/app/backups` e `IMPORT_UPLOAD_DIR=/app/uploads/imports` para que os
arquivos sempre caiam nos volumes persistentes; os valores homonimos de
`.env.example` servem apenas para execucao direta fora do Compose.

PostgreSQL e porta direta da API ficam vinculados a `127.0.0.1`; nao sao publicados na rede. Em producao, exponha somente Web por proxy reverso com HTTPS e certificado valido. Nao publique as portas `5432` ou `3333` no roteador, firewall ou provedor.

Cada JWT de acesso inclui a versao de sessao do usuario. A API consulta o usuario e seus papeis atuais no PostgreSQL em toda rota protegida; desativacao, exclusao, troca de papeis, redefinicao de senha ou revogacao administrativa invalidam imediatamente todos os tokens anteriores. Este projeto nao usa refresh token.

O container operacional executa `apps/web/server.js` gerado por `output: "standalone"` e copia os artefatos `.next/static` e `public`. A pasta `apps/web/out` existe somente no build demonstrativo com `NEXUS_STATIC_DEMO=true` e nao participa do deploy Docker.

## Importacao XLSX

O endpoint operacional de importacao aceita somente upload multipart em `/api/import/upload`. O navegador nao informa caminho de arquivo do servidor. A API valida extensao, MIME type, assinatura ZIP do XLSX e tamanho, calcula SHA-256, armazena o arquivo no volume privado `nexus-imports` e cria um lote de importacao auditavel.

O container da API inclui Python 3 e copia a pasta `scripts/`, pois o importador legado ainda executa `scripts/import_excel.py` de forma controlada no backend.

O inspetor valida a estrutura XLSX antes do parser, ambos executam em copia temporaria isolada com timeout e limites de memoria/saida, e arquivos suspeitos sao rejeitados antes de criar o lote.

## Backups

O Compose monta o volume `nexus-backups` em `/app/backups` na API. Cada backup novo usa `pg_dump --format=custom` completo, incluindo schema, migrations, sequencias e dados, e cifra os bytes nativos com AES-256-GCM. Isso evita perda de SQL `NULL`, JSONB `null` e precisao numerica causada por intermediario JSON. API registra tamanho e SHA-256 do arquivo cifrado. Captura usa snapshot exportado dentro de transacao `REPEATABLE READ`, mantida aberta ate `pg_dump` terminar; manifesto e dump leem o mesmo snapshot sem bloquear lançamentos, e qualquer mudança concorrente de sequence recusa o backup. Diretorio e arquivo recebem permissoes `0700`/`0600`, e container executa como usuario `node`, nao root. Imagem da API usa cliente PostgreSQL 16, igual ao servidor do Compose. Gere chave com `openssl rand -base64 32`, guarde-a fora do repositorio e defina identificador em `BACKUP_ENCRYPTION_KEY_ID`.

Quando `BACKUP_EXTERNAL_DIR` aponta para um volume externo montado, a API cria uma segunda copia cifrada em arquivo temporario exclusivo, compara o SHA-256, sincroniza arquivo e diretorio e publica por hard link atomico sem sobrescrever arquivo existente. Volume precisa suportar hard links dentro do mesmo diretorio; incompatibilidade falha com seguranca. Qualquer falha limpa temporario e copia publicada pela tentativa. Se o arquivo primario desaparecer, verificacao e ensaio usam a copia externa. Um diretorio no mesmo disco nao conta como protecao externa; em producao, monte NAS, volume remoto ou agente de sincronizacao protegido.

Com `BACKUP_SCHEDULE_ENABLED=true`, backup e criado diariamente as 02:00 no fuso `America/Sao_Paulo` e retencao mantem `BACKUP_RETENTION_COUNT`. Retencao usa duas fases auditadas: primeiro troca `COMPLETED` por `RETENTION_PENDING` na mesma transacao da auditoria; somente depois remove arquivos e apaga metadado junto da auditoria final. Falha de banco ou arquivo deixa estado pendente, nunca `COMPLETED` apontando para arquivo removido; proxima execucao retoma com seguranca. `POST /api/backups/:id/restore-rehearsal` valida checksum, autenticidade GCM e estrutura custom com `pg_restore --list`, sem tocar banco. Backups JSON legados continuam disponiveis apenas para leitura/verificacao; restauracao deles e recusada por fidelidade insuficiente.

O comando `npm run backup:restore:prove -- --file <backup.nxb>` executa prova real somente em outro PostgreSQL descartavel, distinto e totalmente sem objetos. Nao aplique migrations antes: `pg_restore --single-transaction --exit-on-error` restaura schema e migrations contidos no dump. Depois do `COMMIT`, nova conexao compara migrations, tabelas, conteúdo tipado, estrutura PostgreSQL e definição/estado das sequences com o manifesto cifrado. CI também repete essa prova dentro da própria imagem API com cliente PostgreSQL 16. Procedimento e barreiras: [`backup-restore-proof.md`](backup-restore-proof.md). Em cada ambiente real, ainda e obrigatorio documentar RPO/RTO, armazenamento externo e exercicio periodico.

## Dominio

Para usar dominio proprio, coloque um proxy reverso como Caddy, Nginx ou Traefik na frente dos servicos:

- Direcione o frontend para o container `web` na porta `3000`.
- Exponha a API ao navegador preferencialmente por `/api` no mesmo dominio do frontend.
- Configure `WEB_ORIGIN` com a origem publica do frontend.
- Evite compilar o frontend com URL absoluta de API; mantenha `NEXT_PUBLIC_API_URL=/api`.
- Exija HTTPS em producao e redirecione HTTP para HTTPS.
