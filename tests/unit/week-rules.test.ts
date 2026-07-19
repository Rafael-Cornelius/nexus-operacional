import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertDateWithinWeek, assertWeekWritable } from "../../apps/api/src/domain/weeks/week-rules";
import { WeeksService } from "../../apps/api/src/modules/weeks/weeks.service";

const monday = new Date("2026-05-04T00:00:00.000Z");
const sunday = new Date("2026-05-10T00:00:00.000Z");
const weekId = "00000000-0000-4000-8000-000000000001";
const repoRoot = join(__dirname, "../..");

function withTransaction<T extends Record<string, unknown>>(transaction: T) {
  return {
    ...transaction,
    $transaction: vi.fn((operation: (client: T) => unknown) => operation(transaction))
  };
}

describe("operational week rules", () => {
  it("accepts only OPEN and REVIEW weeks for writes", () => {
    expect(() => assertWeekWritable({ status: "OPEN" })).not.toThrow();
    expect(() => assertWeekWritable({ status: "REVIEW" })).not.toThrow();
    expect(() => assertWeekWritable({ status: "CLOSED" })).toThrow("Semana fechada");
    expect(() => assertWeekWritable({ status: "ARCHIVED" })).toThrow("Semana fechada");
  });

  it("accepts boundary dates and rejects dates outside the selected week", () => {
    const week = { startsOn: monday, endsOn: sunday };
    expect(() => assertDateWithinWeek(monday, week, "fora")).not.toThrow();
    expect(() => assertDateWithinWeek(sunday, week, "fora")).not.toThrow();
    expect(() => assertDateWithinWeek(new Date("2026-05-03T23:59:59.000Z"), week, "fora")).toThrow("fora");
    expect(() => assertDateWithinWeek(new Date("2026-05-11T00:00:00.000Z"), week, "fora")).toThrow("fora");
  });

  it("blocks overlapping periods before writing to the database", async () => {
    const weeklyPeriod = {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({ id: "existing-week" }),
      create: vi.fn(),
      update: vi.fn()
    };
    const prisma = withTransaction({ weeklyPeriod, $queryRaw: vi.fn() });
    const service = new WeeksService(prisma as never, { record: vi.fn() } as never);

    await expect(service.create({ year: 2026, month: 5, weekNumber: 2, startsOn: "2026-05-08", endsOn: "2026-05-14" })).rejects.toThrow("sobrepoe");
    expect(weeklyPeriod.create).not.toHaveBeenCalled();
    expect(weeklyPeriod.update).not.toHaveBeenCalled();
  });

  it("blocks period edits after a week is closed", async () => {
    const weeklyPeriod = {
      findUnique: vi.fn().mockResolvedValue({ id: "closed-week", status: "CLOSED", deletedAt: null }),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    };
    const prisma = withTransaction({ weeklyPeriod, $queryRaw: vi.fn().mockResolvedValue([{ id: "closed-week" }]) });
    const service = new WeeksService(prisma as never, { record: vi.fn() } as never);

    await expect(service.create({ year: 2026, month: 5, weekNumber: 1, startsOn: monday, endsOn: sunday })).rejects.toThrow("periodo alterado");
    expect(weeklyPeriod.findFirst).not.toHaveBeenCalled();
    expect(weeklyPeriod.update).not.toHaveBeenCalled();
  });

  it("blocks period edits after any operational child exists", async () => {
    const open = { id: weekId, status: "OPEN", deletedAt: null, startsOn: monday, endsOn: sunday, snapshotData: null };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: weekId }]),
      weeklyPeriod: {
        findUnique: vi.fn().mockResolvedValue(open),
        findFirst: vi.fn(),
        update: vi.fn()
      },
      productionOrder: { count: vi.fn().mockResolvedValue(0) },
      productionEntry: { count: vi.fn().mockResolvedValue(1) },
      lossEntry: { count: vi.fn().mockResolvedValue(0) },
      downtimeEntry: { count: vi.fn().mockResolvedValue(0) },
      dosageCheck: { count: vi.fn().mockResolvedValue(0) },
      productivityEntry: { count: vi.fn().mockResolvedValue(0) },
      dashboardSnapshot: { count: vi.fn().mockResolvedValue(0) }
    };
    const service = new WeeksService(withTransaction(transaction) as never, { record: vi.fn() } as never);

    await expect(service.create({
      year: 2026,
      month: 5,
      weekNumber: 1,
      startsOn: "2026-05-05",
      endsOn: "2026-05-11"
    })).rejects.toThrow("dado operacional ou snapshot");
    expect(transaction.weeklyPeriod.update).not.toHaveBeenCalled();
  });

  it("refuses to close a week while operational records await approval", async () => {
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: weekId }]),
      weeklyPeriod: {
        findUnique: vi.fn().mockResolvedValue({ id: weekId, status: "REVIEW", deletedAt: null })
      },
      productionEntry: { count: vi.fn().mockResolvedValue(2) },
      lossEntry: { count: vi.fn().mockResolvedValue(1) },
      downtimeEntry: { count: vi.fn().mockResolvedValue(0) },
      dashboardSnapshot: { create: vi.fn() }
    };
    const prisma = withTransaction(transaction);
    const service = new WeeksService(prisma as never, { record: vi.fn() } as never);

    await expect(service.close(weekId)).rejects.toThrow("3 lancamento(s) sem aprovacao");
    expect(transaction.dashboardSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("requires the OPEN to REVIEW to CLOSED sequence", async () => {
    const weeklyPeriod = {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({ id: weekId, status: "OPEN", deletedAt: null })
        .mockResolvedValueOnce({ id: weekId, status: "OPEN", deletedAt: null }),
      update: vi.fn().mockResolvedValue({ id: weekId, status: "REVIEW" })
    };
    const audit = { record: vi.fn() };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: weekId }]),
      weeklyPeriod,
      productionEntry: { count: vi.fn() },
      lossEntry: { count: vi.fn() },
      downtimeEntry: { count: vi.fn() }
    };
    const prisma = withTransaction(transaction);
    const service = new WeeksService(prisma as never, audit as never);

    await expect(service.review(weekId)).resolves.toMatchObject({ status: "REVIEW" });
    await expect(service.close(weekId)).rejects.toThrow("deve estar em revisao");
    expect(weeklyPeriod.update).toHaveBeenCalledWith({ where: { id: weekId }, data: { status: "REVIEW" } });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "review" }), transaction);
    expect(transaction.productionEntry.count).not.toHaveBeenCalled();
  });

  it("guards operational writes at the database while close holds the week lock", () => {
    const migration = readFileSync(join(repoRoot, "prisma/migrations/0013_week_close_concurrency/migration.sql"), "utf8");
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain("OLD.week_id IS DISTINCT FROM NEW.week_id");
    for (const table of [
      "production_orders",
      "production_entries",
      "loss_entries",
      "downtime_entries",
      "productivity_entries",
      "dosage_checks"
    ]) {
      expect(migration).toContain(`ON "${table}"`);
    }
  });
});
