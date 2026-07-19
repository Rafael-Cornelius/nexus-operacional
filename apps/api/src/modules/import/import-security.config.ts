const MIB = 1024 * 1024;

function boundedNumber(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = true
) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return integer ? Math.trunc(parsed) : parsed;
}

export const importUploadLimitBytes = boundedNumber(
  "IMPORT_MAX_UPLOAD_BYTES",
  25 * MIB,
  1024,
  100 * MIB
);

export function workbookSecurityLimits() {
  return {
    maxEntries: boundedNumber("IMPORT_XLSX_MAX_ENTRIES", 5_000, 5, 20_000),
    maxUncompressedBytes: boundedNumber(
      "IMPORT_XLSX_MAX_UNCOMPRESSED_BYTES",
      128 * MIB,
      MIB,
      512 * MIB
    ),
    maxEntryBytes: boundedNumber(
      "IMPORT_XLSX_MAX_ENTRY_BYTES",
      32 * MIB,
      64 * 1024,
      128 * MIB
    ),
    maxCompressionRatio: boundedNumber(
      "IMPORT_XLSX_MAX_COMPRESSION_RATIO",
      200,
      10,
      1_000,
      false
    ),
    maxPathDepth: boundedNumber("IMPORT_XLSX_MAX_PATH_DEPTH", 20, 4, 50)
  };
}

export function workbookProcessLimits() {
  return {
    inspectTimeoutMs: boundedNumber("IMPORT_INSPECT_TIMEOUT_MS", 30_000, 10, 120_000),
    parserTimeoutMs: boundedNumber("IMPORT_PARSER_TIMEOUT_MS", 60_000, 10, 300_000),
    inspectMaxBufferBytes: boundedNumber(
      "IMPORT_INSPECT_MAX_BUFFER_BYTES",
      MIB,
      16 * 1024,
      4 * MIB
    ),
    parserMaxBufferBytes: boundedNumber(
      "IMPORT_PARSER_MAX_BUFFER_BYTES",
      8 * MIB,
      64 * 1024,
      32 * MIB
    )
  };
}
