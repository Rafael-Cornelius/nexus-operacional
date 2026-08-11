import { createHash } from "node:crypto";
import {
  NATIVE_MANIFEST_FORMAT,
  type NativeBackupManifest,
  type NativeMigrationProof,
  type NativeSequenceProof,
  type NativeStructureProof,
  type NativeTableProof,
} from "./native-backup";

export interface NativeProofSqlClient {
  query<T extends object>(sql: string, ...parameters: unknown[]): Promise<T[]>;
  execute(sql: string, ...parameters: unknown[]): Promise<number>;
}

interface DatabaseTable {
  schema_name: string;
  table_name: string;
}

interface DatabaseColumn {
  column_name: string;
  formatted_type: string;
}

interface DatabaseSequence {
  schema_name: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  min_value: string;
  max_value: string;
  increment_by: string;
  cache_size: string;
  cycle: boolean;
}

export interface StructuralDescriptor {
  object_type: string;
  object_identity: string;
  definition: string;
}

interface MigrationRow {
  migration_name: string;
  checksum: string;
  finished_at: string | Date | null;
  rolled_back_at: string | Date | null;
}

function quoteIdentifier(identifier: string) {
  if (!identifier || identifier.includes("\0")) {
    throw new Error("Identificador PostgreSQL invalido.");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function timestamp(value: string | Date | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function tableKey(schemaName: string, tableName: string) {
  return `${schemaName}.${tableName}`;
}

function canonicalColumnExpression(column: DatabaseColumn) {
  const identifier = `row_value.${quoteIdentifier(column.column_name)}`;
  let textValue = `${identifier}::text`;
  const normalizedType = column.formatted_type.toLowerCase();
  if (normalizedType === "bytea") {
    textValue = `encode(${identifier}, 'hex')`;
  } else if (normalizedType.startsWith("timestamp with time zone")) {
    textValue = `to_char(${identifier} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
  } else if (normalizedType === "time with time zone") {
    textValue = `to_char(${identifier}, 'HH24:MI:SS.USOF')`;
  }
  return `jsonb_build_object(
    'column', ${sqlLiteral(column.column_name)},
    'type', ${sqlLiteral(column.formatted_type)},
    'sqlNull', ${identifier} IS NULL,
    'value', CASE WHEN ${identifier} IS NULL THEN NULL ELSE ${textValue} END
  )`;
}

function fingerprintRowDigests(digests: string[]) {
  const normalized = [...digests].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

export function datasetSha256(
  tables: Record<string, NativeTableProof>,
  sequences: Record<string, NativeSequenceProof> = {},
  structure?: NativeStructureProof,
) {
  return createHash("sha256")
    .update(
      [
        ...Object.entries(tables).map(
          ([table, proof]) => `table:${table}:${proof.rows}:${proof.sha256}`,
        ),
        ...Object.entries(sequences).map(
          ([sequence, proof]) =>
            `sequence:${sequence}:${JSON.stringify(proof)}`,
        ),
        ...(structure ? [`structure:${structure.sha256}`] : []),
      ]
        .sort()
        .join("\n"),
    )
    .digest("hex");
}

async function databaseSequences(client: NativeProofSqlClient) {
  return client.query<DatabaseSequence>(
    `SELECT schemaname AS schema_name, sequencename AS sequence_name
            , data_type::text AS data_type
            , start_value::text AS start_value
            , min_value::text AS min_value
            , max_value::text AS max_value
            , increment_by::text AS increment_by
            , cache_size::text AS cache_size
            , cycle
       FROM pg_catalog.pg_sequences
      WHERE schemaname <> 'information_schema'
        AND schemaname NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY schemaname, sequencename`,
  );
}

export async function collectSequenceProofs(client: NativeProofSqlClient) {
  const sequences = await databaseSequences(client);
  const proofs: Record<string, NativeSequenceProof> = {};
  for (const sequence of sequences) {
    const state = await client.query<{
      last_value: string;
      is_called: boolean;
    }>(
      `SELECT last_value::text AS last_value, is_called
         FROM ${quoteIdentifier(sequence.schema_name)}.${quoteIdentifier(sequence.sequence_name)}`,
    );
    if (
      !sequence.data_type?.trim() ||
      !/^-?\d+$/.test(sequence.start_value) ||
      !/^-?\d+$/.test(sequence.min_value) ||
      !/^-?\d+$/.test(sequence.max_value) ||
      !/^-?\d+$/.test(sequence.increment_by) ||
      !/^\d+$/.test(sequence.cache_size) ||
      typeof sequence.cycle !== "boolean" ||
      !state.length ||
      !/^-?\d+$/.test(state[0].last_value) ||
      typeof state[0].is_called !== "boolean"
    ) {
      throw new Error(
        `Estado invalido para sequence ${tableKey(sequence.schema_name, sequence.sequence_name)}.`,
      );
    }
    proofs[tableKey(sequence.schema_name, sequence.sequence_name)] = {
      dataType: sequence.data_type,
      startValue: sequence.start_value,
      minValue: sequence.min_value,
      maxValue: sequence.max_value,
      incrementBy: sequence.increment_by,
      cacheSize: sequence.cache_size,
      cycle: sequence.cycle,
      lastValue: state[0].last_value,
      isCalled: state[0].is_called,
    };
  }
  return proofs;
}

async function databaseTables(client: NativeProofSqlClient) {
  return client.query<DatabaseTable>(
    `SELECT table_schema AS schema_name, table_name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema <> 'information_schema'
        AND table_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
      ORDER BY table_schema, table_name`,
  );
}

async function tableColumns(
  client: NativeProofSqlClient,
  schemaName: string,
  tableName: string,
) {
  return client.query<DatabaseColumn>(
    `SELECT attribute.attname AS column_name,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = $1
        AND relation.relname = $2
        AND relation.relkind IN ('r', 'p')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum`,
    schemaName,
    tableName,
  );
}

async function tableProof(
  client: NativeProofSqlClient,
  table: DatabaseTable,
): Promise<NativeTableProof> {
  const columns = await tableColumns(
    client,
    table.schema_name,
    table.table_name,
  );
  if (!columns.length) {
    throw new Error(
      `Tabela ${tableKey(table.schema_name, table.table_name)} sem colunas validas.`,
    );
  }
  const rowExpression = `jsonb_build_array(${columns
    .map(canonicalColumnExpression)
    .join(", ")})`;
  const rows = await client.query<{ row_digest: string }>(
    `SELECT md5((${rowExpression})::text) AS row_digest
       FROM ${quoteIdentifier(table.schema_name)}.${quoteIdentifier(table.table_name)} AS row_value`,
  );
  if (rows.some((row) => !/^[0-9a-f]{32}$/i.test(row.row_digest))) {
    throw new Error(
      `PostgreSQL retornou digest invalido para ${tableKey(table.schema_name, table.table_name)}.`,
    );
  }
  return {
    rows: String(rows.length),
    sha256: fingerprintRowDigests(rows.map((row) => row.row_digest)),
  };
}

const structuralQueries = [
  `/* nexus_structure:tables */
   SELECT 'table'::text AS object_type,
          jsonb_build_array(namespace.nspname, relation.relname)::text AS object_identity,
          jsonb_build_object(
            'kind', relation.relkind,
            'persistence', relation.relpersistence,
            'accessMethod', access_method.amname,
            'rowSecurity', relation.relrowsecurity,
            'forceRowSecurity', relation.relforcerowsecurity,
            'replicaIdentity', relation.relreplident,
            'partitionKey', pg_catalog.pg_get_partkeydef(relation.oid),
            'partitionBound', CASE
              WHEN relation.relispartition
              THEN pg_catalog.pg_get_expr(relation.relpartbound, relation.oid, true)
              ELSE NULL
            END,
            'options', COALESCE(
              (SELECT jsonb_agg(option_value.value ORDER BY option_value.value)
                 FROM unnest(relation.reloptions) AS option_value(value)),
              '[]'::jsonb
            )
          )::text AS definition
     FROM pg_catalog.pg_class AS relation
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     LEFT JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation.relam
    WHERE relation.relkind IN ('r', 'p', 'f')
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY namespace.nspname, relation.relname`,
  `/* nexus_structure:columns */
   SELECT 'column'::text AS object_type,
          jsonb_build_array(namespace.nspname, relation.relname, attribute.attname)::text AS object_identity,
          jsonb_build_object(
            'position', attribute.attnum,
            'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
            'notNull', attribute.attnotnull,
            'default', pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true),
            'identity', attribute.attidentity,
            'generated', attribute.attgenerated,
            'collation', CASE
              WHEN attribute.attcollation = 0 THEN NULL
              ELSE jsonb_build_array(collation_namespace.nspname, collation.collname)
            END,
            'compression', attribute.attcompression,
            'storage', attribute.attstorage
          )::text AS definition
     FROM pg_catalog.pg_attribute AS attribute
     JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
       ON attribute_default.adrelid = attribute.attrelid
      AND attribute_default.adnum = attribute.attnum
     LEFT JOIN pg_catalog.pg_collation AS collation ON collation.oid = attribute.attcollation
     LEFT JOIN pg_catalog.pg_namespace AS collation_namespace ON collation_namespace.oid = collation.collnamespace
    WHERE relation.relkind IN ('r', 'p', 'f', 'v', 'm')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY namespace.nspname, relation.relname, attribute.attnum`,
  `/* nexus_structure:constraints */
   SELECT 'constraint'::text AS object_type,
          jsonb_build_array(
            COALESCE(relation_namespace.nspname, domain_namespace.nspname),
            COALESCE(relation.relname, domain_type.typname),
            constraint_row.conname,
            CASE WHEN constraint_row.conrelid <> 0 THEN 'relation' ELSE 'domain' END
          )::text AS object_identity,
          jsonb_build_object(
            'kind', constraint_row.contype,
            'definition', pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
            'deferrable', constraint_row.condeferrable,
            'initiallyDeferred', constraint_row.condeferred,
            'validated', constraint_row.convalidated,
            'noInherit', constraint_row.connoinherit
          )::text AS definition
     FROM pg_catalog.pg_constraint AS constraint_row
     LEFT JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_row.conrelid
     LEFT JOIN pg_catalog.pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
     LEFT JOIN pg_catalog.pg_type AS domain_type ON domain_type.oid = constraint_row.contypid
     LEFT JOIN pg_catalog.pg_namespace AS domain_namespace ON domain_namespace.oid = domain_type.typnamespace
    WHERE COALESCE(relation_namespace.nspname, domain_namespace.nspname) <> 'information_schema'
      AND COALESCE(relation_namespace.nspname, domain_namespace.nspname) NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY object_identity`,
  `/* nexus_structure:indexes */
   SELECT 'index'::text AS object_type,
          jsonb_build_array(namespace.nspname, index_relation.relname)::text AS object_identity,
          jsonb_build_object(
            'definition', pg_catalog.pg_get_indexdef(index_relation.oid),
            'valid', index_row.indisvalid,
            'ready', index_row.indisready,
            'live', index_row.indislive,
            'clustered', index_row.indisclustered,
            'replicaIdentity', index_row.indisreplident
          )::text AS definition
     FROM pg_catalog.pg_index AS index_row
     JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY namespace.nspname, index_relation.relname`,
  `/* nexus_structure:triggers */
   SELECT 'trigger'::text AS object_type,
          jsonb_build_array(namespace.nspname, relation.relname, trigger_row.tgname)::text AS object_identity,
          jsonb_build_object(
            'definition', pg_catalog.pg_get_triggerdef(trigger_row.oid, true),
            'enabled', trigger_row.tgenabled
          )::text AS definition
     FROM pg_catalog.pg_trigger AS trigger_row
     JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE NOT trigger_row.tgisinternal
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY namespace.nspname, relation.relname, trigger_row.tgname`,
  `/* nexus_structure:views */
   SELECT 'view'::text AS object_type,
          jsonb_build_array(namespace.nspname, relation.relname)::text AS object_identity,
          jsonb_build_object(
            'kind', relation.relkind,
            'definition', pg_catalog.pg_get_viewdef(relation.oid, true),
            'populated', relation.relispopulated,
            'options', COALESCE(
              (SELECT jsonb_agg(option_value.value ORDER BY option_value.value)
                 FROM unnest(relation.reloptions) AS option_value(value)),
              '[]'::jsonb
            )
          )::text AS definition
     FROM pg_catalog.pg_class AS relation
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('v', 'm')
      AND namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
    ORDER BY namespace.nspname, relation.relname`,
  `/* nexus_structure:routines */
   SELECT 'routine'::text AS object_type,
          jsonb_build_array(
            namespace.nspname,
            routine_row.proname,
            pg_catalog.pg_get_function_identity_arguments(routine_row.oid)
          )::text AS object_identity,
          CASE
            WHEN routine_row.prokind = 'a' THEN jsonb_build_object(
              'kind', routine_row.prokind,
              'arguments', pg_catalog.pg_get_function_arguments(routine_row.oid),
              'result', pg_catalog.pg_get_function_result(routine_row.oid),
              'aggregateKind', aggregate_row.aggkind,
              'directArguments', aggregate_row.aggnumdirectargs,
              'transitionFunction', NULLIF(aggregate_row.aggtransfn::oid, 0::oid)::regprocedure::text,
              'transitionType', pg_catalog.format_type(aggregate_row.aggtranstype, NULL),
              'transitionSpace', aggregate_row.aggtransspace,
              'finalFunction', NULLIF(aggregate_row.aggfinalfn::oid, 0::oid)::regprocedure::text,
              'combineFunction', NULLIF(aggregate_row.aggcombinefn::oid, 0::oid)::regprocedure::text,
              'serialFunction', NULLIF(aggregate_row.aggserialfn::oid, 0::oid)::regprocedure::text,
              'deserialFunction', NULLIF(aggregate_row.aggdeserialfn::oid, 0::oid)::regprocedure::text,
              'initialValue', aggregate_row.agginitval,
              'parallel', routine_row.proparallel
            )::text
            ELSE jsonb_build_object(
              'kind', routine_row.prokind,
              'definition', pg_catalog.pg_get_functiondef(routine_row.oid)
            )::text
          END AS definition
     FROM pg_catalog.pg_proc AS routine_row
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine_row.pronamespace
     LEFT JOIN pg_catalog.pg_aggregate AS aggregate_row ON aggregate_row.aggfnoid = routine_row.oid
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND routine_row.prokind IN ('f', 'p', 'w', 'a')
    ORDER BY object_identity`,
  `/* nexus_structure:types */
   SELECT 'type'::text AS object_type,
          jsonb_build_array(namespace.nspname, type_row.typname)::text AS object_identity,
          jsonb_build_object(
            'kind', type_row.typtype,
            'category', type_row.typcategory,
            'preferred', type_row.typispreferred,
            'delimiter', type_row.typdelim,
            'length', type_row.typlen,
            'byValue', type_row.typbyval,
            'alignment', type_row.typalign,
            'storage', type_row.typstorage,
            'notNull', type_row.typnotnull,
            'default', type_row.typdefault,
            'baseType', CASE
              WHEN type_row.typbasetype = 0 THEN NULL
              ELSE pg_catalog.format_type(type_row.typbasetype, type_row.typtypmod)
            END,
            'collation', CASE
              WHEN type_row.typcollation = 0 THEN NULL
              ELSE jsonb_build_array(collation_namespace.nspname, collation.collname)
            END,
            'inputFunction', NULLIF(type_row.typinput::oid, 0::oid)::regprocedure::text,
            'outputFunction', NULLIF(type_row.typoutput::oid, 0::oid)::regprocedure::text,
            'receiveFunction', NULLIF(type_row.typreceive::oid, 0::oid)::regprocedure::text,
            'sendFunction', NULLIF(type_row.typsend::oid, 0::oid)::regprocedure::text,
            'enumLabels', (
              SELECT jsonb_agg(
                       jsonb_build_array(enum_row.enumlabel, enum_row.enumsortorder::text)
                       ORDER BY enum_row.enumsortorder
                     )
                FROM pg_catalog.pg_enum AS enum_row
               WHERE enum_row.enumtypid = type_row.oid
            ),
            'attributes', (
              SELECT jsonb_agg(
                       jsonb_build_object(
                         'position', attribute.attnum,
                         'name', attribute.attname,
                         'type', pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                         'collation', CASE
                           WHEN attribute.attcollation = 0 THEN NULL
                           ELSE jsonb_build_array(attribute_collation_namespace.nspname, attribute_collation.collname)
                         END
                       ) ORDER BY attribute.attnum
                     )
                FROM pg_catalog.pg_attribute AS attribute
                LEFT JOIN pg_catalog.pg_collation AS attribute_collation ON attribute_collation.oid = attribute.attcollation
                LEFT JOIN pg_catalog.pg_namespace AS attribute_collation_namespace
                  ON attribute_collation_namespace.oid = attribute_collation.collnamespace
               WHERE attribute.attrelid = type_row.typrelid
                 AND attribute.attnum > 0
                 AND NOT attribute.attisdropped
            ),
            'rangeSubtype', CASE
              WHEN range_row.rngsubtype IS NULL THEN NULL
              ELSE pg_catalog.format_type(range_row.rngsubtype, NULL)
            END,
            'rangeOpclass', CASE
              WHEN sub_opclass.oid IS NULL THEN NULL
              ELSE jsonb_build_array(sub_opclass_namespace.nspname, sub_opclass.opcname)
            END,
            'rangeCollation', CASE
              WHEN range_collation.oid IS NULL THEN NULL
              ELSE jsonb_build_array(range_collation_namespace.nspname, range_collation.collname)
            END,
            'rangeCanonical', NULLIF(range_row.rngcanonical::oid, 0::oid)::regprocedure::text,
            'rangeDifference', NULLIF(range_row.rngsubdiff::oid, 0::oid)::regprocedure::text
          )::text AS definition
     FROM pg_catalog.pg_type AS type_row
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
     LEFT JOIN pg_catalog.pg_class AS composite_relation ON composite_relation.oid = type_row.typrelid
     LEFT JOIN pg_catalog.pg_collation AS collation ON collation.oid = type_row.typcollation
     LEFT JOIN pg_catalog.pg_namespace AS collation_namespace ON collation_namespace.oid = collation.collnamespace
     LEFT JOIN pg_catalog.pg_range AS range_row
       ON range_row.rngtypid = type_row.oid OR range_row.rngmultitypid = type_row.oid
     LEFT JOIN pg_catalog.pg_opclass AS sub_opclass ON sub_opclass.oid = range_row.rngsubopc
     LEFT JOIN pg_catalog.pg_namespace AS sub_opclass_namespace ON sub_opclass_namespace.oid = sub_opclass.opcnamespace
     LEFT JOIN pg_catalog.pg_collation AS range_collation ON range_collation.oid = range_row.rngcollation
     LEFT JOIN pg_catalog.pg_namespace AS range_collation_namespace
       ON range_collation_namespace.oid = range_collation.collnamespace
    WHERE namespace.nspname <> 'information_schema'
      AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND (
        type_row.typtype IN ('d', 'e', 'r', 'm')
        OR (type_row.typtype = 'c' AND composite_relation.relkind = 'c')
        OR (type_row.typtype = 'b' AND type_row.typelem = 0)
      )
    ORDER BY namespace.nspname, type_row.typname`,
] as const;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintStructuralDescriptors(
  descriptors: StructuralDescriptor[],
): NativeStructureProof {
  const objects: Record<string, string> = {};
  for (const descriptor of descriptors) {
    if (
      !descriptor.object_type?.trim() ||
      descriptor.object_type.includes("\0") ||
      !descriptor.object_identity?.trim() ||
      descriptor.object_identity.includes("\0") ||
      typeof descriptor.definition !== "string"
    ) {
      throw new Error("PostgreSQL retornou descritor estrutural invalido.");
    }
    const identity = `${descriptor.object_type}:${descriptor.object_identity}`;
    if (Object.hasOwn(objects, identity)) {
      throw new Error(
        `PostgreSQL retornou objeto estrutural duplicado: ${identity}.`,
      );
    }
    objects[identity] = sha256(descriptor.definition);
  }
  const canonical = Object.entries(objects)
    .sort(([left], [right]) => left.localeCompare(right))
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  return { sha256: sha256(canonical), objects };
}

export async function collectStructureProof(client: NativeProofSqlClient) {
  const descriptors: StructuralDescriptor[] = [];
  for (const sql of structuralQueries) {
    descriptors.push(...(await client.query<StructuralDescriptor>(sql)));
  }
  return fingerprintStructuralDescriptors(descriptors);
}

async function migrationProofs(
  client: NativeProofSqlClient,
  tables: DatabaseTable[],
): Promise<NativeMigrationProof[]> {
  if (
    !tables.some(
      (table) =>
        table.schema_name === "public" &&
        table.table_name === "_prisma_migrations",
    )
  ) {
    throw new Error("Banco nao possui public._prisma_migrations.");
  }
  const migrations = await client.query<MigrationRow>(
    `SELECT migration_name, checksum, finished_at, rolled_back_at
       FROM public."_prisma_migrations"
      ORDER BY migration_name, started_at`,
  );
  return migrations.map((migration) => ({
    migrationName: migration.migration_name,
    checksum: migration.checksum,
    finishedAt: timestamp(migration.finished_at),
    rolledBackAt: timestamp(migration.rolled_back_at),
  }));
}

export async function configureProofSession(client: NativeProofSqlClient) {
  await client.execute("SET TIME ZONE 'UTC'");
  await client.execute("SET DateStyle = 'ISO, YMD'");
  await client.execute("SET IntervalStyle = 'postgres'");
  await client.execute("SET extra_float_digits = 3");
  await client.execute("SET search_path TO pg_catalog, public");
}

export async function collectDatabaseProof(client: NativeProofSqlClient) {
  await configureProofSession(client);
  const tables = await databaseTables(client);
  if (!tables.length) throw new Error("Banco nao possui tabelas para backup.");
  const proofs: Record<string, NativeTableProof> = {};
  for (const table of tables) {
    proofs[tableKey(table.schema_name, table.table_name)] = await tableProof(
      client,
      table,
    );
  }
  return {
    tables: proofs,
    structure: await collectStructureProof(client),
    sequences: await collectSequenceProofs(client),
    migrations: await migrationProofs(client, tables),
  };
}

export async function buildNativeBackupManifest(
  client: NativeProofSqlClient,
  generatedAt: string,
): Promise<NativeBackupManifest> {
  const versions = await client.query<{ server_version: string }>(
    "SHOW server_version",
  );
  const postgresVersion = versions[0]?.server_version;
  if (!postgresVersion) throw new Error("Versao PostgreSQL nao identificada.");
  const proof = await collectDatabaseProof(client);
  return {
    format: NATIVE_MANIFEST_FORMAT,
    generatedAt,
    pgDumpFormat: "custom",
    postgresVersion,
    tables: proof.tables,
    structure: proof.structure,
    sequences: proof.sequences,
    migrations: proof.migrations,
  };
}

function stableMigrations(migrations: NativeMigrationProof[]) {
  return JSON.stringify(
    [...migrations].sort((left, right) =>
      `${left.migrationName}:${left.checksum}`.localeCompare(
        `${right.migrationName}:${right.checksum}`,
      ),
    ),
  );
}

function stableRecord(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  );
}

export function assertProofMatchesManifest(
  manifest: NativeBackupManifest,
  actual: {
    tables: Record<string, NativeTableProof>;
    structure: NativeStructureProof;
    sequences: Record<string, NativeSequenceProof>;
    migrations: NativeMigrationProof[];
  },
) {
  const expectedTables = Object.keys(manifest.tables).sort();
  const actualTables = Object.keys(actual.tables).sort();
  if (JSON.stringify(expectedTables) !== JSON.stringify(actualTables)) {
    throw new Error("Tabelas restauradas divergem do manifesto cifrado.");
  }
  if (
    manifest.structure.sha256 !== actual.structure.sha256 ||
    stableRecord(manifest.structure.objects) !==
      stableRecord(actual.structure.objects)
  ) {
    const identities = new Set([
      ...Object.keys(manifest.structure.objects),
      ...Object.keys(actual.structure.objects),
    ]);
    const firstDifference = [...identities]
      .sort()
      .find(
        (identity) =>
          manifest.structure.objects[identity] !==
          actual.structure.objects[identity],
      );
    throw new Error(
      `Estrutura PostgreSQL restaurada diverge do manifesto cifrado${firstDifference ? `: ${firstDifference}` : "."}`,
    );
  }
  if (stableRecord(manifest.sequences) !== stableRecord(actual.sequences)) {
    throw new Error("Sequences restauradas divergem do manifesto cifrado.");
  }
  for (const table of expectedTables) {
    const expected = manifest.tables[table];
    const restored = actual.tables[table];
    if (
      expected.rows !== restored?.rows ||
      expected.sha256 !== restored?.sha256
    ) {
      throw new Error(`Conteudo restaurado diverge na tabela ${table}.`);
    }
  }
  if (
    stableMigrations(manifest.migrations) !==
    stableMigrations(actual.migrations)
  ) {
    throw new Error("Migrations restauradas divergem do manifesto cifrado.");
  }
  const incomplete = actual.migrations.filter(
    (migration) => !migration.finishedAt && !migration.rolledBackAt,
  );
  if (incomplete.length) {
    throw new Error(
      `Restauracao contem migration incompleta: ${incomplete
        .map((migration) => migration.migrationName)
        .join(", ")}.`,
    );
  }
}

export function totalManifestRows(manifest: NativeBackupManifest) {
  const total = Object.values(manifest.tables).reduce(
    (sum, table) => sum + BigInt(table.rows),
    0n,
  );
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return total.toString();
  return Number(total);
}
