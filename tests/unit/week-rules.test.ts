import { describe, expect, it, vi } from "vitest";
import { assertDateWithinWeek, assertWeekWritable } from "../../apps/api/src/domain/weeks/week-rules";
import { WeeksService } from "../../apps/api/src/modules/weeks/weeks.service";

const monday = new Date("2026-05-04T00:00:00.000Z");
const sunday = new Date("2026-05-10T00:00:00.000Z");

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
      upsert: vi.fn()
    };
    const service = new WeeksService({ weeklyPeriod } as never, { record: vi.fn() } as never);

    await expect(service.create({ year: 2026, month: 5, weekNumber: 2, startsOn: "2026-05-08", endsOn: "2026-05-14" })).rejects.toThrow("sobrepoe");
    expect(weeklyPeriod.upsert).not.toHaveBeenCalled();
  });

  it("blocks period edits after a week is closed", async () => {
    const weeklyPeriod = {
      findUnique: vi.fn().mockResolvedValue({ id: "closed-week", status: "CLOSED", deletedAt: null }),
      findFirst: vi.fn(),
      upsert: vi.fn()
    };
    const service = new WeeksService({ weeklyPeriod } as never, { record: vi.fn() } as never);

    await expect(service.create({ year: 2026, month: 5, weekNumber: 1, startsOn: monday, endsOn: sunday })).rejects.toThrow("periodo alterado");
    expect(weeklyPeriod.findFirst).not.toHaveBeenCalled();
    expect(weeklyPeriod.upsert).not.toHaveBeenCalled();
  });
});
