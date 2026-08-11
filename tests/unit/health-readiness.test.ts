import { ServiceUnavailableException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardService } from "../../apps/api/src/modules/dashboard/dashboard.service";

describe("operational readiness health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports healthy only after PostgreSQL answers", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://configured");
    const query = vi.fn().mockResolvedValue([{ ok: 1 }]);
    const service = new DashboardService({ $queryRaw: query } as never, {} as never);

    await expect(service.health()).resolves.toMatchObject({ status: "ok", database: "reachable" });
    expect(query).toHaveBeenCalledOnce();
  });

  it("returns service unavailable when PostgreSQL is missing or unreachable", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://configured");
    const service = new DashboardService({ $queryRaw: vi.fn().mockRejectedValue(new Error("offline")) } as never, {} as never);

    await expect(service.health()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
