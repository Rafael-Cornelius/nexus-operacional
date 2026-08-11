# Prova real de restauração PostgreSQL

## Formato vigente

Todo backup novo usa `pg_dump --format=custom` e contém schema, migrations, sequências e dados do banco. Bytes nativos são empacotados com manifesto de integridade e cifrados por AES-256-GCM no formato `nexus-encrypted-pgdump-v1`.

Isso preserva tipos PostgreSQL sem passar linhas por JSON. Portanto mantém distinção entre SQL `NULL` e JSON/JSONB `null`, precisão de `numeric`, `bigint`, `bytea`, timestamps e demais representações nativas.

Captura usa snapshot PostgreSQL exportado dentro de transação `REPEATABLE READ`. Transação permanece aberta até `pg_dump` terminar, e manifesto e dump leem exatamente o mesmo snapshot sem congelar lançamentos operacionais. Estado e definição de cada sequência são comparados antes e depois; mudança concorrente recusa o backup em vez de bloquear o ERP.

Agende janela de menor movimento para reduzir recusas causadas por sequences ativas e monitore `BACKUP_COMMAND_TIMEOUT_MS`. Falha ou timeout encerra subprocessos e libera a transação; nenhum arquivo incompleto vira registro `COMPLETED`.

Metadados `COMPLETED` e auditoria de criação são gravados na mesma transação. Registro de falha e auditoria `failed` também são atômicos. Cópia externa usa nome temporário exclusivo, checksum antes da publicação e hard link que recusa sobrescrita.

Retenção marca registro como `RETENTION_PENDING` junto da primeira auditoria antes de remover qualquer arquivo. Exclusão do metadado e auditoria final formam outra transação. Interrupção ou falha deixa item pendente para próxima execução, sem manter status `COMPLETED` para arquivo ausente.

Snapshots `nexus-json-snapshot-v1` antigos continuam disponíveis somente para checksum, autenticação e leitura estrutural. Sistema não os restaura: conversão anterior para JSON não oferece fidelidade suficiente.

`pg_dump` cobre banco atual, não objetos globais do cluster. Roles e tablespaces exigem processo separado com `pg_dumpall --globals-only` e política do provedor.

## Objetivo da prova

```bash
npm run backup:restore:prove -- --file /caminho/seguro/nexus-backup-data.nxb
```

Comando:

1. valida SHA-256 externo, cabeçalho autenticado, `keyId` e AES-256-GCM;
2. descriptografa bundle e dump em diretório temporário `0700`, arquivos `0600`;
3. valida arquivo com `pg_restore --list`;
4. confirma banco alvo distinto, nome exato e ausência total de objetos do usuário;
5. executa `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges`;
6. abre nova conexão depois do `COMMIT`;
7. compara tabelas, contagens, hashes tipados, estrutura completa, migrations e definição/estado das sequências com o manifesto cifrado;
8. remove arquivos temporários mesmo após falha.

`DATABASE_URL` da origem serve somente para comparação textual de identidade. Nenhum cliente ou subprocesso de restauração recebe essa URL. `pg_restore` recebe somente variáveis `PG*` derivadas de `RESTORE_DATABASE_URL`.

## Barreiras obrigatórias

Execução para antes de escrever quando qualquer condição falha:

- origem e alvo precisam usar PostgreSQL;
- host, porta e banco não podem identificar mesmo destino;
- nome do alvo deve ser diferente do nome da origem;
- `RESTORE_DATABASE_EXPECTED_NAME` deve coincidir com URL e `current_database()`;
- `RESTORE_CONFIRMATION` deve ser exatamente `RESTORE_TO_EMPTY_DATABASE:<nome-do-alvo>`;
- alvo deve ser banco recém-criado: sem tabelas, views, sequences, rotinas, extensões do usuário ou schemas adicionais;
- alvo pré-migrado também é recusado;
- arquivo deve conferir com `RESTORE_BACKUP_SHA256` registrado fora dele;
- somente `nexus-encrypted-pgdump-v1` é restaurável;
- `RESTORE_BACKUP_KEY_ID`, quando definido, deve conferir;
- `pg_restore --list` deve reconhecer arquivo custom;
- timeout encerra processo com `SIGTERM` e depois `SIGKILL` se necessário.

Script nunca executa `DROP`, `TRUNCATE`, `prisma migrate deploy` ou limpeza automática. Falha do `pg_restore` causa rollback da transação única. Falha da verificação posterior deixa banco descartável isolado para análise; script não tenta apagá-lo.

## Preparação

1. Provisione PostgreSQL novo e descartável com nome diferente da origem, por exemplo `nexus_restore_20260801`.
2. Restrinja conexões ao executor da prova. Não conecte Web, API, jobs ou usuários ao alvo.
3. Instale clientes `pg_dump` e `pg_restore` compatíveis. Cliente da mesma versão principal do servidor é preferência; cliente `pg_dump` não pode ser mais antigo que servidor origem.
4. Garanta espaço temporário. Durante prova existem bundle descriptografado e dump custom; reserve pelo menos duas vezes tamanho descriptografado esperado.
5. Obtenha SHA-256 registrado no momento da criação/cópia externa. Não trate checksum calculado somente da cópia testada como evidência independente.
6. Injete chave por secret manager ou variável efêmera.

```bash
export DATABASE_URL='postgresql://usuario-origem:senha@host-origem:5432/nexus?schema=public'
export RESTORE_DATABASE_URL='postgresql://usuario-restauro:senha@host-alvo:5432/nexus_restore_20260801?schema=public'
export RESTORE_DATABASE_EXPECTED_NAME='nexus_restore_20260801'
export RESTORE_CONFIRMATION='RESTORE_TO_EMPTY_DATABASE:nexus_restore_20260801'
export RESTORE_BACKUP_SHA256='<sha256 registrado pela API>'
export RESTORE_BACKUP_KEY_ID='<keyId esperado>'
export BACKUP_ENCRYPTION_KEY='<segredo de 32 bytes em base64 ou 64 hex>'
export RESTORE_MAX_BACKUP_BYTES='2147483648'
export RESTORE_COMMAND_TIMEOUT_MS='900000'
```

Parâmetros Prisma `schema`, `connection_limit`, `pool_timeout`, `socket_timeout` e `pgbouncer` são removidos antes de chamar clientes PostgreSQL. Parâmetros libpq reconhecidos, incluindo `sslmode`, `sslrootcert`, `sslcert` e `sslkey`, viram variáveis `PG*`. Parâmetro desconhecido é recusado, não ignorado silenciosamente.

Nunca grave credenciais, chave ou URL completa em relatório, repositório ou histórico compartilhado.

## Evidência esperada

Sucesso imprime JSON sem linhas ou segredos:

```json
{
  "status": "RESTORE_PROOF_PASSED",
  "format": "nexus-encrypted-pgdump-v1",
  "durable": true,
  "destructiveSourceAccess": false,
  "databaseName": "nexus_restore_20260801",
  "migrationCount": 21,
  "tableCount": 34,
  "rowCount": 8240,
  "datasetSha256": "...",
  "sequences": {
    "public.users_id_seq": { "lastValue": "42", "isCalled": true }
  }
}
```

Hashes de conteúdo são calculados com tipo da coluna, marcador explícito de SQL `NULL` e valor textual produzido pelo PostgreSQL. O fingerprint estrutural cobre colunas mesmo em tabelas vazias, tipos/defaults/nullability, constraints, índices, triggers, views, rotinas/agregados e tipos de usuário. Sequências incluem tipo, início, limites, incremento, cache, ciclo, último valor e `is_called`. Números não atravessam `Number` do JavaScript. Contagens ficam como strings no manifesto; JSON final usa número somente dentro do limite seguro.

Guarde saída como artefato protegido e registre horário, duração, checksum, executor, ambiente e ticket de homologação. `snapshotGeneratedAt` ajuda medir RPO; `durationMs` fornece parte da evidência de RTO.

## Depois da prova

Não transforme alvo de ensaio em produção. Valide aplicação contra ele de forma isolada, preserve evidência e descarte banco inteiro pelo fluxo controlado do provedor. Próxima prova exige outro banco recém-criado.

Prova valida arquivo, autenticação, estrutura PostgreSQL, migrations, sequências, tipos, contagens, conteúdo e commit durável no banco. Não valida DNS, troca de tráfego, recuperação de Web/API, roles globais, tablespaces ou tempo de provisionamento. Operação real ainda exige armazenamento externo, monitoramento, responsáveis e RPO/RTO aprovados.
