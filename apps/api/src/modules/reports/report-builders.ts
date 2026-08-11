import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export interface ProductionReportRow {
  date: string;
  sector: string;
  line: string;
  equipment: string;
  shift: string;
  productCode: string;
  productName: string;
  productionOrder: string;
  plannedBatches: number;
  realizedBatches: number;
  producedKg: number;
  lossKg: number;
  overweightKg: number;
  yieldPercent: number;
  productionCost: number;
  lossCost: number;
  overweightCost: number;
}

export interface LossReportRow {
  date: string;
  sector: string;
  equipment: string;
  shift: string;
  productCode: string;
  productionOrder: string;
  type: string;
  reason: string;
  quantityKg: number;
  filmShift1Kg?: number;
  filmShift2Kg?: number;
  boxLossUnits?: number;
  boxLossShift1Units?: number;
  boxLossShift2Units?: number;
  cost: number;
}

export interface DowntimeReportRow {
  date: string;
  sector: string;
  line: string;
  equipment: string;
  shift: string;
  reason: string;
  stoppedMinutes: number;
  stoppedPercent: number;
  realKgHour: number;
  possibleKgHour: number;
}

export interface ProductivityReportRow {
  date: string;
  sector: string;
  equipment: string;
  shift: string;
  producedKg: number;
  productiveHours: number;
  kgPerHour: number;
  source: "INFORMED_MANUALLY" | "LEGACY_UNVERIFIED";
}

export interface OperationalReportData {
  title: string;
  period: string;
  generatedAt: string;
  source: "PostgreSQL";
  summary: {
    producedKg: number;
    plannedBatches: number;
    realizedBatches: number;
    planAchievement: number;
    lossKg: number;
    lossCost: number;
    overweightKg: number;
    overweightCost: number;
    stoppedMinutes: number;
    averageYield: number;
    averageProductivity: number;
    productionRecords: number;
    lossRecords: number;
    downtimeRecords: number;
  };
  production: ProductionReportRow[];
  losses: LossReportRow[];
  downtimes: DowntimeReportRow[];
  productivity: ProductivityReportRow[];
}

const darkBlue = "122036";
const cyan = "22D3EE";
const lightBlue = "E8F6FA";
const lightBorder = "C7D7E3";

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvSection(title: string, headers: string[], rows: unknown[][]) {
  return [csvCell(title), headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\r\n");
}

export function buildOperationalCsv(data: OperationalReportData) {
  const summary = Object.entries(data.summary).map(([metric, value]) => [metric, value]);
  return `\uFEFF${[
    csvSection("Resumo", ["metrica", "valor"], summary),
    csvSection(
      "Producao",
      ["data", "setor", "linha", "equipamento", "turno", "produto", "nome", "op", "planejado", "realizado", "produzido_kg", "perda_kg", "sobrepeso_kg", "rendimento", "custo_producao", "custo_perda", "custo_sobrepeso"],
      data.production.map((row) => Object.values(row))
    ),
    csvSection(
      "Perdas",
      ["data", "setor", "equipamento", "turno", "produto", "op", "tipo", "motivo", "filme_total_kg", "filme_t1_kg", "filme_t2_kg", "caixas_total_un", "caixas_t1_un", "caixas_t2_un", "custo"],
      data.losses.map((row) => [
        row.date,
        row.sector,
        row.equipment,
        row.shift,
        row.productCode,
        row.productionOrder,
        row.type,
        row.reason,
        row.quantityKg,
        row.filmShift1Kg ?? "",
        row.filmShift2Kg ?? "",
        row.boxLossUnits ?? "",
        row.boxLossShift1Units ?? "",
        row.boxLossShift2Units ?? "",
        row.cost
      ])
    ),
    csvSection(
      "Paradas",
      ["data", "setor", "linha", "equipamento", "turno", "motivo", "minutos", "percentual", "kg_h_real", "kg_h_possivel"],
      data.downtimes.map((row) => Object.values(row))
    ),
    csvSection(
      "Produtividade",
      ["data", "setor", "equipamento", "turno", "produzido_kg", "horas_produtivas", "kg_h", "fonte"],
      data.productivity.map((row) => Object.values(row))
    )
  ].join("\r\n\r\n")}`;
}

function styleWorksheet(sheet: ExcelJS.Worksheet, percentColumns: number[] = [], currencyColumns: number[] = []) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  const header = sheet.getRow(1);
  header.height = 24;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: darkBlue } };
    cell.font = { bold: true, color: { argb: "FFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "medium", color: { argb: cyan } } };
  });
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.border = { bottom: { style: "thin", color: { argb: lightBorder } } };
      cell.alignment = { vertical: "middle" };
    });
  });
  for (const index of percentColumns) sheet.getColumn(index).numFmt = "0.00%";
  for (const index of currencyColumns) sheet.getColumn(index).numFmt = 'R$ #,##0.00';
}

function addRowsSheet<T extends object>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: Array<{ header: string; key: keyof T; width: number }>,
  rows: T[],
  percentColumns: number[] = [],
  currencyColumns: number[] = []
) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((column) => ({ ...column, key: String(column.key) }));
  rows.forEach((row) => sheet.addRow(row));
  styleWorksheet(sheet, percentColumns, currencyColumns);
  return sheet;
}

export async function buildOperationalXlsx(data: OperationalReportData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "NEXUS OPERACIONAL";
  workbook.created = new Date(data.generatedAt);
  workbook.modified = new Date(data.generatedAt);

  const summary = workbook.addWorksheet("Resumo");
  summary.columns = [
    { header: "Indicador", key: "metric", width: 32 },
    { header: "Valor", key: "value", width: 22 }
  ];
  summary.addRows([
    { metric: "Relatorio", value: data.title },
    { metric: "Periodo", value: data.period },
    { metric: "Fonte", value: data.source },
    { metric: "Atualizado em", value: data.generatedAt },
    { metric: "Producao total (kg)", value: data.summary.producedKg },
    { metric: "Atingimento do plano", value: data.summary.planAchievement },
    { metric: "Rendimento medio", value: data.summary.averageYield },
    { metric: "Produtividade media (kg/h)", value: data.summary.averageProductivity },
    { metric: "Perdas (kg)", value: data.summary.lossKg },
    { metric: "Custo das perdas", value: data.summary.lossCost },
    { metric: "Sobrepeso (kg)", value: data.summary.overweightKg },
    { metric: "Custo do sobrepeso", value: data.summary.overweightCost },
    { metric: "Tempo parado (min)", value: data.summary.stoppedMinutes },
    { metric: "Registros de producao", value: data.summary.productionRecords },
    { metric: "Registros de perdas", value: data.summary.lossRecords },
    { metric: "Registros de paradas", value: data.summary.downtimeRecords }
  ]);
  styleWorksheet(summary);
  summary.getCell("B7").numFmt = "0.00%";
  summary.getCell("B8").numFmt = "0.00%";
  summary.getCell("B11").numFmt = 'R$ #,##0.00';
  summary.getCell("B13").numFmt = 'R$ #,##0.00';
  summary.getColumn(1).eachCell((cell, row) => {
    if (row > 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: lightBlue } };
  });

  addRowsSheet<ProductionReportRow>(workbook, "Producao", [
    { header: "Data", key: "date", width: 12 }, { header: "Setor", key: "sector", width: 10 },
    { header: "Linha", key: "line", width: 16 }, { header: "Equipamento", key: "equipment", width: 18 },
    { header: "Turno", key: "shift", width: 12 }, { header: "Produto", key: "productCode", width: 14 },
    { header: "Nome", key: "productName", width: 28 }, { header: "OP", key: "productionOrder", width: 16 },
    { header: "Planejado", key: "plannedBatches", width: 14 }, { header: "Realizado", key: "realizedBatches", width: 14 },
    { header: "Produzido kg", key: "producedKg", width: 16 }, { header: "Perda kg", key: "lossKg", width: 14 },
    { header: "Sobrepeso kg", key: "overweightKg", width: 16 }, { header: "Rendimento", key: "yieldPercent", width: 14 },
    { header: "Custo producao", key: "productionCost", width: 18 }, { header: "Custo perda", key: "lossCost", width: 16 },
    { header: "Custo sobrepeso", key: "overweightCost", width: 18 }
  ], data.production, [14], [15, 16, 17]);

  addRowsSheet<LossReportRow>(workbook, "Perdas", [
    { header: "Data", key: "date", width: 12 }, { header: "Setor", key: "sector", width: 10 },
    { header: "Equipamento", key: "equipment", width: 18 }, { header: "Turno", key: "shift", width: 12 },
    { header: "Produto", key: "productCode", width: 14 }, { header: "OP", key: "productionOrder", width: 16 },
    { header: "Tipo", key: "type", width: 20 }, { header: "Motivo", key: "reason", width: 32 },
    { header: "Filme total kg", key: "quantityKg", width: 16 },
    { header: "Filme T1 kg", key: "filmShift1Kg", width: 14 }, { header: "Filme T2 kg", key: "filmShift2Kg", width: 14 },
    { header: "Caixas total un", key: "boxLossUnits", width: 16 },
    { header: "Caixas T1 un", key: "boxLossShift1Units", width: 14 }, { header: "Caixas T2 un", key: "boxLossShift2Units", width: 14 },
    { header: "Custo", key: "cost", width: 16 }
  ], data.losses, [], [15]);

  addRowsSheet<DowntimeReportRow>(workbook, "Paradas", [
    { header: "Data", key: "date", width: 12 }, { header: "Setor", key: "sector", width: 10 },
    { header: "Linha", key: "line", width: 16 }, { header: "Equipamento", key: "equipment", width: 18 },
    { header: "Turno", key: "shift", width: 12 }, { header: "Motivo", key: "reason", width: 32 },
    { header: "Minutos", key: "stoppedMinutes", width: 14 }, { header: "Percentual", key: "stoppedPercent", width: 14 },
    { header: "kg/h real", key: "realKgHour", width: 14 }, { header: "kg/h possivel", key: "possibleKgHour", width: 16 }
  ], data.downtimes, [8]);

  addRowsSheet<ProductivityReportRow>(workbook, "Produtividade", [
    { header: "Data", key: "date", width: 12 }, { header: "Setor", key: "sector", width: 10 },
    { header: "Equipamento", key: "equipment", width: 18 }, { header: "Turno", key: "shift", width: 12 },
    { header: "Produzido kg", key: "producedKg", width: 16 }, { header: "Horas produtivas", key: "productiveHours", width: 18 },
    { header: "kg/h", key: "kgPerHour", width: 16 }, { header: "Fonte", key: "source", width: 24 }
  ], data.productivity);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export async function buildOperationalPdf(data: OperationalReportData) {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: "A4", margin: 42, bufferPages: true, info: { Title: data.title, Author: "NEXUS OPERACIONAL" } });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    const ensureSpace = (height = 28) => {
      if (document.y + height <= document.page.height - 46) return;
      document.addPage();
    };
    const section = (title: string) => {
      ensureSpace(44);
      document.moveDown(0.6).font("Helvetica-Bold").fontSize(13).fillColor("#122036").text(title);
      document.moveDown(0.3);
    };
    const line = (label: string, value: string) => {
      ensureSpace();
      document.font("Helvetica-Bold").fontSize(9).fillColor("#334155").text(`${label}: `, { continued: true });
      document.font("Helvetica").fillColor("#0F172A").text(value);
    };

    document.rect(0, 0, document.page.width, 92).fill("#122036");
    document.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(20).text("NEXUS OPERACIONAL", 42, 30);
    document.font("Helvetica").fontSize(11).fillColor("#A5F3FC").text(data.title, 42, 58);
    document.y = 112;
    line("Periodo", data.period);
    line("Fonte", data.source);
    line("Atualizacao", data.generatedAt);

    section("Resumo executivo");
    line("Producao total", `${formatNumber(data.summary.producedKg, 3)} kg`);
    line("Atingimento do plano", `${formatNumber(data.summary.planAchievement * 100)}%`);
    line("Rendimento medio", `${formatNumber(data.summary.averageYield * 100)}%`);
    line("Produtividade media", `${formatNumber(data.summary.averageProductivity, 3)} kg/h`);
    line("Perdas", `${formatNumber(data.summary.lossKg, 3)} kg - ${formatCurrency(data.summary.lossCost)}`);
    line("Sobrepeso", `${formatNumber(data.summary.overweightKg, 3)} kg - ${formatCurrency(data.summary.overweightCost)}`);
    line("Tempo parado", `${formatNumber(data.summary.stoppedMinutes)} min`);
    line("Registros", `producao ${data.summary.productionRecords}; perdas ${data.summary.lossRecords}; paradas ${data.summary.downtimeRecords}`);

    section("Producao por lancamento");
    if (!data.production.length) line("Situacao", "Nenhum registro aprovado no periodo.");
    for (const row of data.production) {
      ensureSpace(36);
      document.font("Helvetica-Bold").fontSize(8).fillColor("#0F172A").text(`${row.date} | ${row.sector} | Produto ${row.productCode} | OP ${row.productionOrder}`);
      document.font("Helvetica").fillColor("#475569").text(`Produzido ${formatNumber(row.producedKg, 3)} kg | perda ${formatNumber(row.lossKg, 3)} kg | rendimento ${formatNumber(row.yieldPercent * 100)}%`);
    }

    section("Perdas");
    if (!data.losses.length) line("Situacao", "Nenhum registro aprovado no periodo.");
    for (const row of data.losses) {
      ensureSpace(40);
      document.font("Helvetica-Bold").fontSize(8).fillColor("#0F172A").text(`${row.date} | ${row.sector} | ${row.type} | ${formatNumber(row.quantityKg, 3)} kg`);
      const measurement = (value: number | undefined, digits: number, unit: string) =>
        value === undefined ? "nao informado" : `${formatNumber(value, digits)} ${unit}`;
      document.font("Helvetica").fillColor("#475569").text(
        `Filme T1/T2 ${measurement(row.filmShift1Kg, 3, "kg")} / ${measurement(row.filmShift2Kg, 3, "kg")} | ` +
        `caixas ${measurement(row.boxLossUnits, 0, "un")} (T1/T2 ${measurement(row.boxLossShift1Units, 0, "un")} / ${measurement(row.boxLossShift2Units, 0, "un")})`
      );
      document.font("Helvetica").fillColor("#475569").text(`${row.reason || "Sem motivo informado"} | ${formatCurrency(row.cost)}`);
    }

    section("Paradas");
    if (!data.downtimes.length) line("Situacao", "Nenhum registro aprovado no periodo.");
    for (const row of data.downtimes) {
      ensureSpace(30);
      document.font("Helvetica-Bold").fontSize(8).fillColor("#0F172A").text(`${row.date} | ${row.sector} | ${row.equipment || row.line || "Sem equipamento"} | ${formatNumber(row.stoppedMinutes)} min`);
      document.font("Helvetica").fillColor("#475569").text(row.reason);
    }

    section("Produtividade informada");
    if (!data.productivity.length) line("Situacao", "Nenhum apontamento informado aprovado no periodo.");
    for (const row of data.productivity) {
      ensureSpace(30);
      document.font("Helvetica-Bold").fontSize(8).fillColor("#0F172A").text(
        `${row.date} | ${row.sector} | ${formatNumber(row.kgPerHour, 3)} kg/h | ${row.source}`
      );
      document.font("Helvetica").fillColor("#475569").text(
        `${formatNumber(row.producedKg, 3)} kg informados em ${formatNumber(row.productiveHours, 3)} horas produtivas.`
      );
    }

    const pages = document.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index += 1) {
      document.switchToPage(index);
      document.font("Helvetica").fontSize(8).fillColor("#64748B").text(`Pagina ${index + 1} de ${pages.count}`, 42, document.page.height - 64, {
        align: "right",
        width: document.page.width - 84,
        lineBreak: false
      });
    }
    document.end();
  });
}
