import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ImportService } from "../../apps/api/src/modules/import/import.service";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const inspectorPath = join(repoRoot, "scripts/inspect_workbook.py");
const pythonBin = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
const rootRelationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
const workbookRelationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

type WorkbookEntries = Record<string, string>;

function validEntries(): WorkbookEntries {
  return {
    "[Content_Types].xml": contentTypes,
    "_rels/.rels": rootRelationships,
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": workbookRelationships,
    "xl/worksheets/sheet1.xml": worksheet
  };
}

function writeWorkbook(path: string, entries: WorkbookEntries) {
  const payload = Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
  const fixtureWriter = [
    "import base64,json,sys,zipfile",
    "entries=json.loads(base64.b64decode(sys.argv[2]).decode('utf-8'))",
    "with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as zf:",
    "    for name, value in entries.items(): zf.writestr(name, value.encode('utf-8'))"
  ].join("\n");
  execFileSync(pythonBin, ["-I", "-B", "-X", "utf8", "-c", fixtureWriter, path, payload]);
}

function inspect(path: string, extraArgs: string[] = []) {
  return spawnSync(
    pythonBin,
    ["-I", "-B", "-X", "utf8", inspectorPath, "--file", path, ...extraArgs],
    { cwd: repoRoot, encoding: "utf8" }
  );
}

describe("XLSX import security", () => {
  let testDirectory: string;
  const previousEnvironment: Record<string, string | undefined> = {};
  const environmentKeys = [
    "IMPORT_TEMP_DIR",
    "IMPORT_UPLOAD_DIR",
    "IMPORT_INSPECT_TIMEOUT_MS",
    "IMPORT_INSPECT_MAX_BUFFER_BYTES",
    "IMPORT_PARSER_TIMEOUT_MS",
    "PYTHON_BIN"
  ];

  beforeEach(() => {
    testDirectory = mkdtempSync(join(tmpdir(), "nexus-import-test-"));
    for (const key of environmentKeys) previousEnvironment[key] = process.env[key];
    delete process.env.PYTHON_BIN;
  });

  afterEach(() => {
    for (const key of environmentKeys) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(testDirectory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("accepts a structurally valid XLSX with the expected workbook relationships", () => {
    const workbookPath = join(testDirectory, "valid.xlsx");
    writeWorkbook(workbookPath, validEntries());

    const result = inspect(workbookPath);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      entryCount: 5,
      sheetCount: 1
    });
  });

  it("rejects missing workbook relationships and archive path traversal", () => {
    const missingRelationshipPath = join(testDirectory, "missing-relationship.xlsx");
    const missingRelationship = validEntries();
    delete missingRelationship["xl/_rels/workbook.xml.rels"];
    writeWorkbook(missingRelationshipPath, missingRelationship);

    const missingResult = inspect(missingRelationshipPath);
    expect(missingResult.status).toBe(2);
    expect(missingResult.stderr).toContain("Parte obrigatoria ausente");

    const traversalPath = join(testDirectory, "traversal.xlsx");
    writeWorkbook(traversalPath, { ...validEntries(), "../escape.xml": "unsafe" });

    const traversalResult = inspect(traversalPath);
    expect(traversalResult.status).toBe(2);
    expect(traversalResult.stderr).toContain("Caminho perigoso");
  });

  it("rejects macros and external or embedded objects", () => {
    const macroPath = join(testDirectory, "macro.xlsx");
    writeWorkbook(macroPath, { ...validEntries(), "xl/vbaProject.bin": "macro" });

    const macroResult = inspect(macroPath);
    expect(macroResult.status).toBe(2);
    expect(macroResult.stderr).toContain("Macro ou conteudo executavel");

    const externalPath = join(testDirectory, "external.xlsx");
    writeWorkbook(externalPath, {
      ...validEntries(),
      "xl/worksheets/_rels/sheet1.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid/payload" TargetMode="External"/>
        </Relationships>`
    });

    const externalResult = inspect(externalPath);
    expect(externalResult.status).toBe(2);
    expect(externalResult.stderr).toContain("objeto externo");

    const embeddedPath = join(testDirectory, "embedded.xlsx");
    writeWorkbook(embeddedPath, { ...validEntries(), "xl/embeddings/payload.bin": "payload" });

    const embeddedResult = inspect(embeddedPath);
    expect(embeddedResult.status).toBe(2);
    expect(embeddedResult.stderr).toContain("Objeto incorporado");
  });

  it("enforces entry and uncompressed-size ceilings against ZIP bombs", () => {
    const workbookPath = join(testDirectory, "oversized.xlsx");
    writeWorkbook(workbookPath, validEntries());

    const entryResult = inspect(workbookPath, ["--max-entries", "4"]);
    expect(entryResult.status).toBe(2);
    expect(entryResult.stderr).toContain("arquivos internos");

    const sizeResult = inspect(workbookPath, ["--max-uncompressed-bytes", "100"]);
    expect(sizeResult.status).toBe(2);
    expect(sizeResult.stderr).toContain("ZIP bomb");
  });

  it("runs the parser from an isolated copy and always removes the working directory", async () => {
    const workbookPath = join(testDirectory, "valid.xlsx");
    const temporaryRoot = join(testDirectory, "isolated");
    writeWorkbook(workbookPath, validEntries());
    process.env.IMPORT_TEMP_DIR = temporaryRoot;

    const service = new ImportService({} as never, {} as never);
    const runImport = (
      service as unknown as {
        runLegacyWorkbookImport(path: string): Promise<{ sheetCount?: number }>;
      }
    ).runLegacyWorkbookImport.bind(service);

    await expect(runImport(workbookPath)).resolves.toMatchObject({ sheetCount: 1 });
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "kills timed-out inspection processes and cleans their isolated files",
    async () => {
      const workbookPath = join(testDirectory, "valid.xlsx");
      const temporaryRoot = join(testDirectory, "isolated-timeout");
      const slowPython = join(testDirectory, "slow-python");
      writeWorkbook(workbookPath, validEntries());
      writeFileSync(slowPython, "#!/bin/sh\nsleep 2\n", { mode: 0o700 });
      chmodSync(slowPython, 0o700);
      process.env.IMPORT_TEMP_DIR = temporaryRoot;
      process.env.IMPORT_INSPECT_TIMEOUT_MS = "25";
      process.env.PYTHON_BIN = slowPython;

      const service = new ImportService({} as never, {} as never);
      const runImport = (
        service as unknown as { runLegacyWorkbookImport(path: string): Promise<unknown> }
      ).runLegacyWorkbookImport.bind(service);

      await expect(runImport(workbookPath)).rejects.toBeInstanceOf(BadRequestException);
      expect(readdirSync(temporaryRoot)).toEqual([]);
    }
  );

  it.skipIf(process.platform === "win32")(
    "caps inspector output and cleans its isolated files",
    async () => {
      const workbookPath = join(testDirectory, "valid.xlsx");
      const temporaryRoot = join(testDirectory, "isolated-output-limit");
      const noisyPython = join(testDirectory, "noisy-python");
      writeWorkbook(workbookPath, validEntries());
      writeFileSync(noisyPython, "#!/bin/sh\ndd if=/dev/zero bs=65536 count=1 2>/dev/null\n", {
        mode: 0o700
      });
      chmodSync(noisyPython, 0o700);
      process.env.IMPORT_TEMP_DIR = temporaryRoot;
      process.env.IMPORT_INSPECT_MAX_BUFFER_BYTES = String(16 * 1024);
      process.env.PYTHON_BIN = noisyPython;

      const service = new ImportService({} as never, {} as never);
      const runImport = (
        service as unknown as { runLegacyWorkbookImport(path: string): Promise<unknown> }
      ).runLegacyWorkbookImport.bind(service);

      await expect(runImport(workbookPath)).rejects.toMatchObject({
        response: expect.objectContaining({ message: expect.stringContaining("saida maior") })
      });
      expect(readdirSync(temporaryRoot)).toEqual([]);
    }
  );

  it("removes a rejected upload before creating an import batch", async () => {
    const uploadRoot = join(testDirectory, "uploads");
    const maliciousPath = join(testDirectory, "external.xlsx");
    const entries = {
      ...validEntries(),
      "xl/worksheets/_rels/sheet1.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///etc/passwd" TargetMode="External"/>
        </Relationships>`
    };
    writeWorkbook(maliciousPath, entries);
    const buffer = readFileSync(maliciousPath);
    process.env.IMPORT_TEMP_DIR = join(testDirectory, "isolated-upload");
    process.env.IMPORT_UPLOAD_DIR = uploadRoot;
    const create = vi.fn();
    const service = new ImportService(
      { importBatch: { create } } as never,
      { record: vi.fn() } as never
    );

    await expect(
      service.uploadWorkbook({
        originalname: "external.xlsx",
        mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: buffer.length,
        buffer
      })
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(create).not.toHaveBeenCalled();
    expect(readdirSync(uploadRoot)).toEqual([]);
  });

  it("creates the upload batch and its audit record in the same transaction", async () => {
    const workbookPath = join(testDirectory, "valid.xlsx");
    writeWorkbook(workbookPath, validEntries());
    const buffer = readFileSync(workbookPath);
    process.env.IMPORT_UPLOAD_DIR = join(testDirectory, "uploads");
    const created = {
      id: "11111111-1111-4111-8111-111111111111",
      sourceFile: "valid.xlsx",
      originalFileName: "valid.xlsx",
      fileHash: "hash",
      fileSizeBytes: BigInt(buffer.length),
      status: "STAGED",
      summary: {},
      errors: [],
      _count: { stagingRecords: 0 }
    };
    const tx = { importBatch: { create: vi.fn().mockResolvedValue(created) } };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx))
    };
    const audit = { record: vi.fn().mockResolvedValue({}) };
    const service = new ImportService(prisma as never, audit as never);
    vi.spyOn(
      service as unknown as { runLegacyWorkbookImport(path: string, name: string): Promise<unknown> },
      "runLegacyWorkbookImport"
    ).mockResolvedValue({
      file: "isolated.xlsx",
      errors: {},
      legacyData: {
        products: [], productionEntries: [], lossEntries: [], downtimeEntries: [],
        importErrors: [], operationalImportErrors: []
      }
    });

    await expect(service.uploadWorkbook({
      originalname: "valid.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: buffer.length,
      buffer
    })).resolves.toMatchObject({ id: created.id, status: "STAGED" });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.importBatch.create).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "upload", entityId: created.id }),
      tx
    );
  });
});
