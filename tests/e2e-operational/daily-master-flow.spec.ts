import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse
} from "@playwright/test";

const adminEmail = process.env.INITIAL_ADMIN_EMAIL;
const adminPassword = process.env.INITIAL_ADMIN_PASSWORD;
const apiPort = Number(process.env.PLAYWRIGHT_OPERATIONAL_API_PORT ?? "3333");
const webPort = Number(process.env.PLAYWRIGHT_OPERATIONAL_WEB_PORT ?? "3100");
const apiURL = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;

interface Entity {
  id: string;
}

interface SessionResponse {
  user: Entity & {
    email: string;
    name: string;
    roles: string[];
  };
}

interface Sector extends Entity {
  code: "P1" | "P2";
}

interface LossType extends Entity {
  code: string;
  active: boolean;
}

interface ReferenceData {
  sectors: Sector[];
  lines: Entity[];
  lossTypes: LossType[];
  downtimeReasons: Entity[];
}

interface Week extends Entity {
  year: number;
  month: number;
  weekNumber: number;
  startsOn: string;
  endsOn: string;
  status: "OPEN" | "REVIEW" | "CLOSED" | "ARCHIVED";
}

interface VersionedEntity extends Entity {
  version: number;
  workflowStatus: string;
  submittedBy?: string | null;
  approvedBy?: string | null;
}

interface ProductionEntry extends VersionedEntity {
  productionOrderId: string | null;
  calculationRuleVersions: Record<string, number>;
}

interface CalculationRule {
  id: string;
  version: number;
  status: "ACTIVE" | "REVIEW_REQUIRED";
  governanceStatus: "NOT_REQUIRED" | "PENDING_REVIEW" | "APPROVED" | "RETIRED";
}

interface ApprovedRecord extends Entity {
  status: string;
  approvedBy: string | null;
}

interface PricePeriod extends ApprovedRecord {
  recordVersion: number;
}

interface GoalRecord extends Entity {
  workflowStatus: string;
  approvedBy: string | null;
}

interface SnapshotResponse extends Entity {
  snapshotData: null | {
    format: string;
    contentHash: string;
    summary: {
      records: number;
      counts: {
        production: number;
        losses: number;
        downtimes: number;
        dosage: number;
        productivity: number;
      };
    };
  };
}

interface WeeklySummary {
  exportId: string;
  week: Week;
  summary: {
    productionTotalKg: number;
  } | null;
}

interface OperationalExport {
  exportId: string;
  format: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  dataBase64: string;
}

interface AuditRow extends Entity {
  userId: string | null;
  module: string;
  action: string;
  entity: string;
  entityId: string | null;
  correlationId: string | null;
  requestOrigin: string | null;
  deviceId: string | null;
  appVersion: string | null;
}

async function jsonResponse<T>(response: APIResponse, expectedStatus: number, operation: string): Promise<T> {
  const body = await response.text();
  if (response.status() !== expectedStatus) {
    const excerpt = body.length > 1_500 ? `${body.slice(0, 1_500)}...` : body;
    throw new Error(
      `${operation}: HTTP ${response.status()} recebido; esperado ${expectedStatus}. Corpo: ${excerpt || "<vazio>"}`
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${operation}: resposta HTTP ${expectedStatus} nao contem JSON valido. Corpo: ${body.slice(0, 500)}`);
  }
}

async function login(api: APIRequestContext, email: string, password: string, operation: string) {
  return jsonResponse<SessionResponse>(
    await api.post("/api/auth/login", { data: { email, password } }),
    201,
    operation
  );
}

function firstAvailableWeek(existing: Week[]) {
  for (let year = 2199; year >= 2100; year -= 1) {
    const startsOn = `${year}-01-04`;
    const endsOn = `${year}-01-10`;
    const startTime = Date.parse(`${startsOn}T00:00:00.000Z`);
    const endTime = Date.parse(`${endsOn}T00:00:00.000Z`);
    const collides = existing.some((week) => {
      const sameKey = week.year === year && week.month === 1 && week.weekNumber === 1;
      const overlaps = Date.parse(week.startsOn) <= endTime && Date.parse(week.endsOn) >= startTime;
      return sameKey || overlaps;
    });
    if (!collides) return { year, month: 1, weekNumber: 1, startsOn, endsOn };
  }
  throw new Error("E2E operacional: nao existe periodo semanal descartavel livre entre 2100 e 2199.");
}

test.beforeAll(() => {
  if (!adminEmail || !adminPassword) {
    throw new Error("INITIAL_ADMIN_EMAIL e INITIAL_ADMIN_PASSWORD sao obrigatorios no E2E operacional.");
  }
});

test("executa fluxo mestre diario real com segregacao de aprovacao e rastreabilidade", async () => {
  test.setTimeout(180_000);

  const runToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const approverEmail = `e2e-approver-${runToken.toLowerCase()}@nexus.local`;
  const approverPassword = `Nexus-${runToken}-Aa9!`;
  const adminCorrelationId = `e2e-admin-${runToken}`;
  const approverCorrelationId = `e2e-approver-${runToken}`;
  const adminDeviceId = `ci-admin-${runToken}`;
  const approverDeviceId = `ci-approver-${runToken}`;

  const adminApi = await playwrightRequest.newContext({
    baseURL: apiURL,
    extraHTTPHeaders: {
      Origin: webOrigin,
      "x-app-version": "e2e-operational",
      "x-correlation-id": adminCorrelationId,
      "x-device-id": adminDeviceId
    }
  });
  let approverApi: APIRequestContext | undefined;

  try {
    const adminSession = await login(adminApi, adminEmail!, adminPassword!, "login do administrador inicial");
    expect(adminSession.user.email).toBe(adminEmail!.toLowerCase());
    expect(adminSession.user.roles).toContain("ADMIN");

    const approver = await jsonResponse<Entity>(
      await adminApi.post("/api/users", {
        data: {
          email: approverEmail,
          name: `Aprovador E2E ${runToken}`,
          password: approverPassword,
          roles: ["MANAGER"]
        }
      }),
      201,
      "criacao do usuario aprovador"
    );

    approverApi = await playwrightRequest.newContext({
      baseURL: apiURL,
      extraHTTPHeaders: {
        Origin: webOrigin,
        "x-app-version": "e2e-operational",
        "x-correlation-id": approverCorrelationId,
        "x-device-id": approverDeviceId
      }
    });
    const approverSession = await login(approverApi, approverEmail, approverPassword, "login do usuario aprovador");
    expect(approverSession.user.id).toBe(approver.id);
    expect(approverSession.user.roles).toEqual(["MANAGER"]);

    const initialReferences = await jsonResponse<ReferenceData>(
      await adminApi.get("/api/reference-data"),
      200,
      "consulta inicial dos cadastros-base"
    );
    let sectorP1 = initialReferences.sectors.find((sector) => sector.code === "P1");
    if (!sectorP1) {
      sectorP1 = await jsonResponse<Sector>(
        await adminApi.post("/api/reference-data/sectors", {
          data: { code: "P1", name: "Producao P1", description: "Setor criado pelo E2E operacional real" }
        }),
        201,
        "criacao do setor P1"
      );
    }
    let sectorP2 = initialReferences.sectors.find((sector) => sector.code === "P2");
    if (!sectorP2) {
      sectorP2 = await jsonResponse<Sector>(
        await adminApi.post("/api/reference-data/sectors", {
          data: { code: "P2", name: "Producao P2", description: "Setor criado pelo E2E operacional real" }
        }),
        201,
        "criacao do setor P2"
      );
    }
    expect(sectorP2.code).toBe("P2");

    const line = await jsonResponse<Entity>(
      await adminApi.post("/api/reference-data/lines", {
        data: {
          sectorId: sectorP1.id,
          code: `L${runToken}`,
          name: `Linha E2E ${runToken}`,
          active: true
        }
      }),
      201,
      "criacao da linha de producao"
    );
    const equipment = await jsonResponse<Entity>(
      await adminApi.post("/api/equipment", {
        data: {
          productionLineId: line.id,
          code: `EQ${runToken}`,
          name: `Equipamento E2E ${runToken}`,
          type: "Empacotadora",
          active: true
        }
      }),
      201,
      "criacao do equipamento"
    );
    const shift = await jsonResponse<Entity>(
      await adminApi.post("/api/shifts", {
        data: {
          code: `T${runToken}`,
          name: `Turno E2E ${runToken}`,
          startsAt: "06:00",
          endsAt: "14:00",
          active: true
        }
      }),
      201,
      "criacao do turno"
    );

    let lossType = initialReferences.lossTypes.find((candidate) => candidate.code === "PACKAGING");
    if (!lossType?.active) {
      lossType = await jsonResponse<LossType>(
        await adminApi.post("/api/reference-data/loss-types", {
          data: { code: "PACKAGING", name: "Perda de embalagem", defaultGoalKg: 5, active: true }
        }),
        201,
        "criacao ou reativacao do tipo de perda"
      );
    }
    const downtimeReason = await jsonResponse<Entity>(
      await adminApi.post("/api/reference-data/downtime-reasons", {
        data: { name: `Ajuste operacional E2E ${runToken}`, active: true }
      }),
      201,
      "criacao do motivo de parada"
    );

    const weeks = await jsonResponse<Week[]>(await adminApi.get("/api/weeks"), 200, "consulta de semanas existentes");
    const period = firstAvailableWeek(weeks);
    const week = await jsonResponse<Week>(
      await adminApi.post("/api/weeks", { data: period }),
      201,
      "criacao da semana operacional"
    );
    expect(week.status).toBe("OPEN");

    const product = await jsonResponse<Entity>(
      await adminApi.post("/api/products", {
        data: {
          code: `PROD-${runToken}`,
          name: `Produto E2E ${runToken}`,
          defaultSector: "P1",
          packageWeightKg: 1,
          boxWeightKg: 10,
          packagesPerBox: 10,
          massWeightKg: 100,
          targetPackageWeightG: 1_000,
          unit: "kg",
          overweightTolerancePercent: 0.02,
          formula: "BOX_WEIGHT",
          packageFilmWeightG: 5,
          notes: "Cadastro descartavel do fluxo mestre E2E"
        }
      }),
      201,
      "criacao do produto"
    );
    const priceDraft = await jsonResponse<PricePeriod>(
      await adminApi.post(`/api/products/${product.id}/prices`, {
        data: {
          startsOn: period.startsOn,
          endsOn: period.endsOn,
          pricePerKg: 12.5,
          filmCostPerKg: 8.25,
          currency: "BRL",
          origin: "Contrato descartavel E2E",
          observation: "Preco criado para validar segregacao de aprovacao"
        }
      }),
      201,
      "criacao do preco em rascunho"
    );
    expect(priceDraft.status).toBe("DRAFT");
    const approvedPrice = await jsonResponse<PricePeriod>(
      await approverApi.post(`/api/products/${product.id}/prices/${priceDraft.id}/approve`, {
        data: {
          recordVersion: priceDraft.recordVersion,
          reason: "Preco conferido pelo aprovador independente no E2E"
        }
      }),
      201,
      "aprovacao independente do preco"
    );
    expect(approvedPrice.status).toBe("APPROVED");
    expect(approvedPrice.approvedBy).toBe(approver.id);

    const goalDraft = await jsonResponse<GoalRecord>(
      await adminApi.post("/api/goals", {
        data: {
          name: `Meta de producao E2E ${runToken}`,
          metric: "produced_kg",
          sectorCode: "P1",
          lineId: line.id,
          equipmentId: equipment.id,
          shiftId: shift.id,
          productId: product.id,
          targetValue: "500",
          comparator: ">=",
          measurementUnit: "kg",
          cadence: "WEEKLY",
          startsOn: period.startsOn,
          endsOn: period.endsOn,
          responsibleId: adminSession.user.id,
          reason: "Meta criada para validar o ciclo operacional completo"
        }
      }),
      201,
      "criacao da meta em rascunho"
    );
    expect(goalDraft.workflowStatus).toBe("DRAFT");
    const approvedGoal = await jsonResponse<GoalRecord>(
      await approverApi.post(`/api/goals/${goalDraft.id}/approve`, {
        data: { reason: "Meta conferida pelo aprovador independente no E2E" }
      }),
      201,
      "aprovacao da meta"
    );
    expect(approvedGoal.workflowStatus).toBe("APPROVED");
    expect(approvedGoal.approvedBy).toBe(approver.id);

    const calculationRules = await jsonResponse<CalculationRule[]>(
      await adminApi.get("/api/calculation-rules"),
      200,
      "consulta das regras de calculo"
    );
    const reviewRules = calculationRules.filter((rule) => rule.status === "REVIEW_REQUIRED");
    expect(reviewRules.length).toBeGreaterThan(0);
    for (const rule of reviewRules.filter((candidate) => candidate.governanceStatus === "PENDING_REVIEW")) {
      await jsonResponse<Entity>(
        await adminApi.post(`/api/calculation-rules/${encodeURIComponent(rule.id)}/versions/${rule.version}/approve`, {
          data: { reason: "Regra revisada e aprovada para execucao descartavel do E2E" }
        }),
        201,
        `aprovacao da regra ${rule.id}@${rule.version}`
      );
    }
    const governedRules = await jsonResponse<CalculationRule[]>(
      await adminApi.get("/api/calculation-rules"),
      200,
      "reconsulta das regras aprovadas"
    );
    expect(
      governedRules.filter((rule) => rule.status === "REVIEW_REQUIRED").every((rule) => rule.governanceStatus === "APPROVED")
    ).toBe(true);

    const production = await jsonResponse<ProductionEntry>(
      await adminApi.post("/api/production", {
        data: {
          weekId: week.id,
          sector: "P1",
          lineId: line.id,
          equipmentId: equipment.id,
          shiftId: shift.id,
          date: period.startsOn,
          productId: product.id,
          productionOrder: `OP-${runToken}`,
          plannedBatches: 10,
          realizedBatches: 9,
          usedReworkKg: 0,
          packedBoxes: 80,
          weighingLossKg: 1,
          generatedReworkKg: 2,
          averagePackageWeightG: 1_010,
          notes: "Lancamento diario descartavel"
        }
      }),
      201,
      "criacao do lancamento de producao"
    );
    expect(production.workflowStatus).toBe("DRAFT");
    expect(Object.keys(production.calculationRuleVersions).length).toBeGreaterThan(0);
    expect(production.productionOrderId).toBeTruthy();
    const submittedProduction = await jsonResponse<ProductionEntry>(
      await adminApi.post(`/api/production/${production.id}/submit`, {
        data: { version: production.version, reason: "Producao conferida e enviada para aprovacao" }
      }),
      201,
      "submissao da producao"
    );
    expect(submittedProduction.submittedBy).toBe(adminSession.user.id);
    const approvedProduction = await jsonResponse<ProductionEntry>(
      await approverApi.post(`/api/production/${production.id}/approve`, {
        data: { version: submittedProduction.version, reason: "Producao aprovada por usuario independente" }
      }),
      201,
      "aprovacao independente da producao"
    );
    expect(approvedProduction.workflowStatus).toBe("APPROVED");
    expect(approvedProduction.approvedBy).toBe(approver.id);

    const loss = await jsonResponse<VersionedEntity>(
      await adminApi.post("/api/losses", {
        data: {
          weekId: week.id,
          date: period.startsOn,
          sector: "P1",
          productId: product.id,
          productionOrderId: production.productionOrderId,
          equipmentId: equipment.id,
          shiftId: shift.id,
          lossTypeId: lossType.id,
          quantityKg: 2,
          filmShift1Kg: 1.25,
          filmShift2Kg: 0.75,
          packedBoxes: 80,
          reason: "Ajuste de embalagem E2E",
          notes: "Perda descartavel do fluxo mestre"
        }
      }),
      201,
      "criacao da perda"
    );
    const submittedLoss = await jsonResponse<VersionedEntity>(
      await adminApi.post(`/api/losses/${loss.id}/submit`, {
        data: { version: loss.version, reason: "Perda conferida e enviada para aprovacao" }
      }),
      201,
      "submissao da perda"
    );
    const approvedLoss = await jsonResponse<VersionedEntity>(
      await approverApi.post(`/api/losses/${loss.id}/approve`, {
        data: { version: submittedLoss.version, reason: "Perda aprovada por usuario independente" }
      }),
      201,
      "aprovacao independente da perda"
    );
    expect(approvedLoss.workflowStatus).toBe("APPROVED");
    expect(approvedLoss.approvedBy).toBe(approver.id);

    const productionStart = `${period.startsOn}T08:00:00.000Z`;
    const productionEnd = `${period.startsOn}T16:00:00.000Z`;
    const downtimeStart = `${period.startsOn}T10:00:00.000Z`;
    const downtimeEnd = `${period.startsOn}T10:30:00.000Z`;
    const downtime = await jsonResponse<VersionedEntity>(
      await adminApi.post("/api/downtime", {
        data: {
          weekId: week.id,
          date: period.startsOn,
          sector: "P1",
          lineId: line.id,
          equipmentId: equipment.id,
          shiftId: shift.id,
          productionStart,
          productionEnd,
          downtimeStart,
          downtimeEnd,
          producedMassKg: 800,
          downtimeReasonId: downtimeReason.id,
          notes: "Parada descartavel do fluxo mestre"
        }
      }),
      201,
      "criacao da parada"
    );
    const submittedDowntime = await jsonResponse<VersionedEntity>(
      await adminApi.post(`/api/downtime/${downtime.id}/submit`, {
        data: { version: downtime.version, reason: "Parada conferida e enviada para aprovacao" }
      }),
      201,
      "submissao da parada"
    );
    const approvedDowntime = await jsonResponse<VersionedEntity>(
      await approverApi.post(`/api/downtime/${downtime.id}/approve`, {
        data: { version: submittedDowntime.version, reason: "Parada aprovada por usuario independente" }
      }),
      201,
      "aprovacao independente da parada"
    );
    expect(approvedDowntime.workflowStatus).toBe("APPROVED");
    expect(approvedDowntime.approvedBy).toBe(approver.id);

    const dosage = await jsonResponse<VersionedEntity & { operatorId: string | null; sampleCount: number }>(
      await adminApi.post("/api/dosage", {
        data: {
          weekId: week.id,
          productId: product.id,
          sector: "P1",
          equipmentId: equipment.id,
          shiftId: shift.id,
          operatorId: adminSession.user.id,
          date: period.startsOn,
          sampleWeightsG: [995, 1_000, 1_005, 1_002],
          notes: "Amostra descartavel do fluxo mestre"
        }
      }),
      201,
      "registro da dosagem"
    );
    expect(dosage.operatorId).toBe(adminSession.user.id);
    expect(dosage.sampleCount).toBe(4);
    expect(dosage.workflowStatus).toBe("DRAFT");
    const submittedDosage = await jsonResponse<VersionedEntity>(
      await adminApi.post(`/api/dosage/${dosage.id}/submit`, {
        data: { version: dosage.version, reason: "Dosagem conferida e enviada para aprovacao" }
      }),
      201,
      "submissao da dosagem"
    );
    expect(submittedDosage.submittedBy).toBe(adminSession.user.id);
    const approvedDosage = await jsonResponse<VersionedEntity>(
      await approverApi.post(`/api/dosage/${dosage.id}/approve`, {
        data: { version: submittedDosage.version, reason: "Dosagem aprovada por usuario independente" }
      }),
      201,
      "aprovacao independente da dosagem"
    );
    expect(approvedDosage.workflowStatus).toBe("APPROVED");
    expect(approvedDosage.approvedBy).toBe(approver.id);

    const productivity = await jsonResponse<VersionedEntity & { dataSource: string; kgPerHour: string | number }>(
      await adminApi.post("/api/productivity", {
        data: {
          weekId: week.id,
          sector: "P1",
          equipmentId: equipment.id,
          shiftId: shift.id,
          date: period.startsOn,
          producedKg: 800,
          productiveHours: 7.5,
          notes: "Produtividade informada descartavel do fluxo mestre"
        }
      }),
      201,
      "criacao da produtividade informada"
    );
    expect(productivity.dataSource).toBe("INFORMED_MANUALLY");
    expect(Number(productivity.kgPerHour)).toBeGreaterThan(0);
    expect(productivity.workflowStatus).toBe("DRAFT");
    const submittedProductivity = await jsonResponse<VersionedEntity>(
      await adminApi.post(`/api/productivity/${productivity.id}/submit`, {
        data: { version: productivity.version, reason: "Produtividade conferida e enviada para aprovacao" }
      }),
      201,
      "submissao da produtividade informada"
    );
    expect(submittedProductivity.submittedBy).toBe(adminSession.user.id);
    const approvedProductivity = await jsonResponse<VersionedEntity>(
      await approverApi.post(`/api/productivity/${productivity.id}/approve`, {
        data: { version: submittedProductivity.version, reason: "Produtividade aprovada por usuario independente" }
      }),
      201,
      "aprovacao independente da produtividade informada"
    );
    expect(approvedProductivity.workflowStatus).toBe("APPROVED");
    expect(approvedProductivity.approvedBy).toBe(approver.id);

    const reviewedWeek = await jsonResponse<Week>(
      await approverApi.patch(`/api/weeks/${week.id}/review`, { data: {} }),
      200,
      "envio da semana para revisao"
    );
    expect(reviewedWeek.status).toBe("REVIEW");
    const closedWeek = await jsonResponse<Week>(
      await approverApi.patch(`/api/weeks/${week.id}/close`, { data: {} }),
      200,
      "fechamento da semana"
    );
    expect(closedWeek.status).toBe("CLOSED");

    const weeklySummary = await jsonResponse<WeeklySummary>(
      await approverApi.get(`/api/reports/weekly-summary?weekId=${week.id}`),
      200,
      "consulta do relatorio semanal"
    );
    expect(weeklySummary.week.id).toBe(week.id);
    expect(weeklySummary.summary).not.toBeNull();
    expect(weeklySummary.summary?.productionTotalKg).toBeGreaterThan(0);

    const exported = await jsonResponse<OperationalExport>(
      await approverApi.post("/api/reports/operational-export", {
        data: { period: "weekly", format: "xlsx", weekId: week.id }
      }),
      201,
      "exportacao operacional XLSX"
    );
    expect(exported.format).toBe("xlsx");
    expect(exported.fileName).toMatch(/\.xlsx$/);
    expect(exported.mimeType).toContain("spreadsheetml");
    expect(exported.sizeBytes).toBeGreaterThan(1_000);
    expect(exported.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(exported.dataBase64, "base64").byteLength).toBe(exported.sizeBytes);

    const snapshot = await jsonResponse<SnapshotResponse>(
      await approverApi.get(`/api/weeks/${week.id}/snapshot`),
      200,
      "consulta do snapshot fechado"
    );
    expect(snapshot.snapshotData?.format).toBe("nexus-week-snapshot-v2");
    expect(snapshot.snapshotData?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.snapshotData?.summary.counts).toMatchObject({
      production: 1,
      losses: 1,
      downtimes: 1,
      dosage: 1,
      productivity: 1
    });
    expect(snapshot.snapshotData?.summary.records).toBeGreaterThanOrEqual(5);

    const reopenedWeek = await jsonResponse<Week>(
      await approverApi.patch(`/api/weeks/${week.id}/reopen`, {
        data: { reason: "Reabertura descartavel para validar rastreabilidade completa" }
      }),
      200,
      "reabertura justificada da semana"
    );
    expect(reopenedWeek.status).toBe("OPEN");

    const audit = await jsonResponse<AuditRow[]>(
      await approverApi.get("/api/audit?take=500"),
      200,
      "consulta da trilha de auditoria"
    );
    expect(
      audit.some(
        (entry) => entry.module === "production" && entry.action === "submit" && entry.entityId === production.id && entry.userId === adminSession.user.id
      )
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.module === "production" && entry.action === "approve" && entry.entityId === production.id && entry.userId === approver.id
      )
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.module === "losses" && entry.action === "approve" && entry.entityId === loss.id && entry.userId === approver.id
      )
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.module === "downtime" && entry.action === "approve" && entry.entityId === downtime.id && entry.userId === approver.id
      )
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.module === "dosage" && entry.action === "create" && entry.entityId === dosage.id && entry.userId === adminSession.user.id
      )
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.module === "dosage" && entry.action === "approve" && entry.entityId === dosage.id && entry.userId === approver.id
      )
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.module === "productivity" && entry.action === "submit" && entry.entityId === productivity.id && entry.userId === adminSession.user.id
      )
    ).toBe(true);
    expect(
      audit.some(
        (entry) => entry.module === "productivity" && entry.action === "approve" && entry.entityId === productivity.id && entry.userId === approver.id
      )
    ).toBe(true);
    const reopenAudit = audit.find(
      (entry) => entry.module === "weeks" && entry.action === "reopen" && entry.entityId === week.id
    );
    expect(reopenAudit).toMatchObject({
      userId: approver.id,
      correlationId: approverCorrelationId,
      requestOrigin: webOrigin,
      deviceId: approverDeviceId,
      appVersion: "e2e-operational"
    });

    await jsonResponse<{ ok: boolean }>(
      await approverApi.post("/api/auth/logout", { data: {} }),
      201,
      "logout do aprovador"
    );
    await jsonResponse<unknown>(
      await approverApi.get("/api/auth/me"),
      401,
      "validacao da sessao encerrada do aprovador"
    );
    await jsonResponse<{ ok: boolean }>(
      await adminApi.post("/api/auth/logout", { data: {} }),
      201,
      "logout do administrador"
    );
    await jsonResponse<unknown>(
      await adminApi.get("/api/auth/me"),
      401,
      "validacao da sessao encerrada do administrador"
    );
  } finally {
    await approverApi?.dispose();
    await adminApi.dispose();
  }
});
