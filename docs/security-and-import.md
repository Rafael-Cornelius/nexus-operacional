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

Product and operational inconsistencies are merged into the same batch; operational promotion cannot erase product errors. Rows created by a batch retain `importBatchId` and start as `DRAFT`. Reprocessing the same batch is idempotent for its own rows; a collision with data from another batch becomes a pending error instead of an overwrite. A failed run is marked `FAILED`, and `IMPORTING`/`CERTIFIED` batches cannot run concurrently or be silently replaced.

`GET /api/import/:batchId/reconciliation` compares source and PostgreSQL counts plus planned/realized batches, boxes, rework, produced mass, weighing loss, overweight, registered loss and downtime. A matching report is only eligible; it becomes certified after an ADMIN calls `POST /api/import/:batchId/reconciliation/certify` with a reason. Certification is reconciliation of the imported set, not approval of each operational entry.

For the supplied `Relatórios -MAIO-JUNHO 2026.xlsx`, the raw parser found 199 production, 93 loss and 360 downtime rows. Period/anomaly quarantine leaves 161, 68 and 240 eligible rows and records 189 operational inconsistencies, in addition to 127 product inconsistencies. This is intentional: the file contains July data despite its name, date cells interpreted as April/November and a planned value that matches another OP. The workbook is therefore not automatically certifiable.
