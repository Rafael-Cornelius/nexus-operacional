# Security and Import Notes

## API security

- `JwtAuthGuard` is registered globally and accepts the HTTP-only `nexus_session` cookie on protected routes. Bearer tokens are still accepted for administrative/API tooling.
- The frontend must not store sensitive tokens in `localStorage`; authenticated browser calls use `credentials: "include"`.
- `@Public()` is restricted to login, health check and the stateless production calculation preview. Logout requires a valid session.
- Every protected request verifies the JWT signature and then loads the user from PostgreSQL. Missing, inactive or soft-deleted users are rejected immediately.
- Access JWTs contain a session-version claim (`sv`). The guard requires an exact match with `users.session_version`; tokens without this claim are rejected.
- `RolesGuard` reads `@Roles(...)` metadata and blocks users outside the allowed role set. Roles are always loaded from the current database relationships, never trusted from JWT claims.
- `ADMIN` can access every role-protected route by policy.
- Human API errors are returned for missing, invalid or expired sessions.
- Password reset, role changes, activation-state changes, soft deletion, restoration and explicit session revocation increment `session_version`, invalidating all previously issued JWTs for that user.
- Administrators can revoke every session for a user with `POST /users/:id/revoke-sessions`. The operation is audited without token, password or password-hash material.
- The application intentionally has no refresh-token flow. After a global revocation the user must authenticate again. Normal logout only clears the current browser cookie.
- Workbook-derived JSON must not be written to `apps/web`. Private migration exports go under `data/private` or another backend-only location.

## Workbook import

`scripts/import_excel.py` reads the XLSX package directly and does not require Excel, pandas or openpyxl.

Before parsing, `scripts/inspect_workbook.py` validates the XLSX package in an isolated temporary directory. It rejects path traversal, DTD/entity declarations, macros, OLE/ActiveX/embedded content, external relationships, unexpected workbook relationships and archives above the configured entry, expanded-size, per-entry, depth or compression-ratio limits. Python runs with an argument array (no shell), isolated mode, restricted environment, timeouts and output caps; cleanup runs even on failure.

The current normalized product flow:

1. Read workbook sheets and cached formula errors.
2. Extract `Pacotes-caixas` rows as product identity and package/box configuration.
3. Extract `Banco de Dados Pesagen` rows as mass weight, box weight and target package weight.
4. Merge by product code.
5. Preserve source sheet/row references.
6. Emit duplicate and missing-field issues as import-error-shaped objects.
7. Compare dates with a period declared in the workbook filename when one is present; out-of-period rows are quarantined instead of silently imported.
8. Detect suspicious planned-batch values that duplicate another production order, including the supplied workbook's `Plan x Real (P2)!F54` anomaly.

Known duplicated weighing codes in the supplied workbook:

- `70974`
- `73735`
- `76379`
- `76678`

The importer never imports formula errors such as `#N/A`, `#REF!`, `#DIV/0!` or `#VALUE!` as numbers.

Product and operational inconsistencies are merged into the same batch; operational promotion cannot erase product errors.

### Staging and human review

Upload never writes products, production, losses or downtime into official tables. Parser output first enters `import_staging_records`, related to immutable `import_batches`. Promotable normalized domains are `PRODUCT`, `PRODUCTION`, `LOSS` and `DOWNTIME`. `DOSAGE` and `HISTORY` preserve source evidence in mandatory quarantine; issues without a safe domain use `UNKNOWN` and cannot be promoted.

Every staging row stores:

- immutable parser/source representation in `raw_original`;
- normalized parser interpretation in `interpreted_value`;
- optional human correction in `corrected_value`, without overwriting either earlier representation;
- source SHA-256-derived fingerprint and stable per-batch key;
- sheet, cell and row lineage when available;
- validation issues;
- classification `VALID`, `WARNING`, `ERROR`, `DUPLICATE` or `REQUIRES_REVIEW`;
- review decision, reason, reviewer, timestamp and optimistic `version`;
- promoted entity ID and timestamp after a successful transaction.

Product sector, formula, tolerance, unit and active state are not present unambiguously in the mapped source. `xlsx-normalizer-v4` leaves them null and classifies the row as `ERROR`; an authorized human must supply and justify them. The parser also stopped creating technical product names, derived weights and package counts. Missing or conflicting prices remain null in staging and the workbook price is never promoted as approval.

Production calculations run during staging only when every required source value and product configuration is known. A blank/error cell stays null; OPs are never synthesized as `LEG-*`; no calculation substitutes zero. Every P1 production row remains `REQUIRES_REVIEW` while expected-yield, real-yield and derived-loss rules remain unhomologated in calculation registry. Promotion recalculates these rules and still requires an `APPROVED` decision.

Downtime with end clock before start clock is an `ERROR`, not an assumed midnight rollover. Every nonempty mapped row is preserved, including incomplete and out-of-period rows. Approval requires UUIDs of an active official line and reason; promotion validates all timestamps against an existing writable week. The parser never assumes P1 or produced mass zero. Every cell with an error cache or formula containing `#REF!` creates its own blocking `UNKNOWN/ERROR` record with sheet, cell, formula, attributes, cached value, type and context. Full metric lineage beyond these detected cells remains required before certification.

Packaging loss rows preserve original B:I values, cell types, formulas/formula attributes, film total, film T1/T2 in kilograms, box total and box T1/T2 in units. The database and API validate both subtotals independently. Blank/error/non-numeric remains null, never zero. Box units are integers, never added to `quantityKg`, and no implicit conversion is allowed. Because the source does not identify sector or product, both require human correction; promotion then requires positive film cost from an `APPROVED` price period and records its lineage.

The 60 constants in `Perdas - dosagem` are stored one source cell per staging row with original value and missing-context list. They cannot be approved, corrected into an official record or promoted because the workbook does not identify product, OP, date, week, sector, equipment, shift or operator. The four materialized `ARQUIVO MORTO` tables are also preserved row by row, including table/range, source cells, legacy ID/key/version/hash and raw values. Their 67 P1, 13 P2, 59 downtime and 26 loss records remain non-promotable until a dedicated historical reconciliation flow exists.

Review API, restricted to `ADMIN`, `MANAGER` and `SUPERVISOR`:

- `GET /api/import/:batchId/staging` lists original, interpreted and corrected values with filters and bounded pagination;
- `GET /api/import/:batchId/staging/summary` returns counts by domain, classification and decision;
- `PATCH /api/import/:batchId/staging/:recordId` records a validated correction and mandatory justification;
- `POST /api/import/:batchId/staging/:recordId/review` approves, ignores or rejects with mandatory justification.

Every mutation uses optimistic row versioning. Stale reviewers receive HTTP 409. `ERROR` and `DUPLICATE` cannot be approved without correction; they may only be corrected, ignored or rejected. `DOSAGE` and `HISTORY` cannot be approved or corrected through the operational promotion flow; they can only remain pending or be ignored/rejected with justification while the immutable evidence stays stored. Matching `import_errors` are resolved with same reviewer and reason. Audit logs keep before/after metadata without replacing original workbook values.

For the supplied workbook, a real run of `xlsx-normalizer-v4` creates 3,199 evidence rows: 60 `DOSAGE`, 657 `DOWNTIME`, 165 `HISTORY`, 95 `LOSS`, 154 `PRODUCT`, 455 `PRODUCTION` and 1,613 cell-level formula/error records in `UNKNOWN`. Classification is deliberately fail-closed: 2,970 `ERROR`, 225 `REQUIRES_REVIEW` and 4 `DUPLICATE`; none is declared valid before the missing source decisions are reviewed. Product evidence includes 87 normalized-by-code records plus 67 source issues kept separately. Counts are not a count of promotable business records.

### Atomic promotion

`POST /api/import/:batchId/promote` is restricted to `ADMIN` and `MANAGER`. Legacy `POST /api/import/operational-data` delegates to same promotion service and has same roles. Promotion:

1. rejects unresolved non-valid staging rows;
2. obtains batch lock through status `PROMOTING`;
3. validates corrected/interpreted JSON again;
4. promotes products, weight configuration, production, losses and downtime inside one Prisma transaction at `Serializable` isolation;
5. rejects exact repeated source rows and downtime overlap instead of overwriting official records; distinct loss rows on the same date/machine remain distinct;
6. links every official row to batch and staging source;
7. writes promotion audit inside same transaction;
8. commits batch summary and status only after all rows succeed.

Any database failure rolls back products, entries, lineage, batch transition and audit together. Batch becomes `FAILED` only in a separate post-rollback status update and may be retried after diagnosis. Repeated promotion after a completed commit returns prior result with `idempotent: true` and creates no duplicate rows. Official operational rows start as `DRAFT`; approved import anomalies remain visible as `ATTENTION` with notes.

The initial batch insert, all nested staging/error inserts and its upload audit also share one serializable transaction. The private file is removed if parsing or database/audit persistence fails. Loss and downtime mutations likewise lock, mutate and audit in one serializable transaction.

Production and losses never accept a staged workbook price as operational approval. They require a matching `ProductPricePeriod` in status `APPROVED`, effective on the row date, and persist `pricePeriodId`, version, origin and currency. New products may enter cadastro, but their operational rows remain blocked until the independent price workflow is completed. Losses and downtimes also require an already configured writable week for their date; the importer does not create a guessed “week 1”.

PostgreSQL triggers independently verify that a referenced price period belongs to the same product, was approved when assigned, covers the entry date and matches the stored version, origin and currency. Production additionally requires its unit price snapshot to equal the governed period. Approval/retirement metadata for goals and prices can only change during an allowed workflow transition and becomes immutable afterward.

When a single batch contains a genuinely new product and operational rows for that code, promotion fails before any official write with an actionable message. The operator must first create/review the product through the governed product flow, create a price draft and obtain independent approval. The workbook price is not a substitute for that approval. A dedicated phased master-data promotion and `PRICE` staging domain remain future work; the current atomic batch never weakens price governance to make a new product pass.

`GET /api/import/:batchId/reconciliation` compares Excel-normalized, staging and PostgreSQL values for counts plus planned/realized batches, boxes, rework, produced mass, weighing loss, overweight, registered loss, filme T1/T2, caixa T1/T2 and downtime. Response exposes Excel-to-staging and staging-to-database differences separately. Certification requires both comparisons to match, zero pending import errors, zero pending staging reviews, every promoted operational row in `APPROVED` and independent source integrity. An ignored, rejected or corrected source divergence therefore cannot be silently certified. Dataset hash includes original/interpreted/corrected staging values and full imported operational dimensions.

Metric totals carry an `unknownMetrics` completeness ledger. A blank, error or non-numeric source increments the unknown count and the API returns that metric as `INCOMPLETE`/`null`, alongside its known subtotal; it never displays or compares the missing value as zero. Human corrections still require a future adjustment ledger (`source + approved adjustments = staging`) before full certification can accept a legitimate source-to-staging difference.

Current parser reads direct input metrics but derives production mass, overweight and downtime minutes from interpreted inputs; it does not expose every cached Excel result/formula/cell independently. New batches therefore record `sourceIntegrity.independentDerivedMetrics = false` and `completeReconciliationScope = false`, and cannot be certified even if PostgreSQL matches staging. The backend also verifies an explicit metric contract and knows that productivity, dosage, costs, packages, history and P1/P2 sector totals are absent from the current comparison; changing one boolean cannot bypass that gate. This prevents circular or partial comparison from being presented as complete Excel reconciliation. Cell-level parser enrichment and the missing database queries must be implemented and tested before full-scope certification can become eligible. The ADMIN endpoint remains fail-closed until that contract is complete.

Batches already marked `CERTIFIED` before this evidence contract are migrated to `LEGACY_CERTIFIED`. They remain immutable and queryable, but are never presented as current certification and cannot have their old hash silently rewritten. Reprocessing requires a new batch and keeps the historical certificate intact.

For the supplied `Relatórios -MAIO-JUNHO 2026.xlsx`, the v4 parser preserves 455 production, 95 loss and 657 downtime rows instead of discarding incomplete, out-of-period or anomalous rows. It also preserves the union of 1,454 cached `#REF!` results and 1,609 formulas containing `#REF!` as 1,613 cell-level records. This is intentional evidence capture, not automatic eligibility. The workbook is not certifiable without correction, reconciliation and operational approval.
