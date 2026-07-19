import { describe, expect, it, vi } from "vitest";
import { RequestContextService } from "../../apps/api/src/infrastructure/request-context/request-context.service";
import { AuditService } from "../../apps/api/src/modules/audit/audit.service";

describe("audit request context", () => {
  it("adds correlation, IP, browser, origin, device and version to every audit row", async () => {
    const prisma = { auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) } };
    const context = new RequestContextService();
    const audit = new AuditService(prisma as never, context);

    await new Promise<void>((resolve, reject) => {
      context.run({
        correlationId: "request-20260718",
        ipAddress: "127.0.0.1",
        userAgent: "Nexus Test Browser",
        requestOrigin: "http://localhost:3000",
        deviceId: "factory-tablet-01",
        appVersion: "2026.07.18"
      }, () => {
        audit.record({ module: "production", action: "update", entity: "ProductionEntry" })
          .then(() => resolve())
          .catch(reject);
      });
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correlationId: "request-20260718",
        ipAddress: "127.0.0.1",
        userAgent: "Nexus Test Browser",
        requestOrigin: "http://localhost:3000",
        deviceId: "factory-tablet-01",
        appVersion: "2026.07.18"
      })
    });
  });
});
