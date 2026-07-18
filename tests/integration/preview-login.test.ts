import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidDemoAdminCredentials } from "../../apps/web/lib/demo-auth";

describe("preview login flow", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("authenticates the configured admin and creates a valid session", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NEXT_PUBLIC_DEMO_ADMIN_EMAIL", "rafaelcornelius@nexus.local");
    vi.stubEnv("NEXT_PUBLIC_DEMO_ADMIN_PASSWORD", "NexusAdmin@2026");

    const api = await import("../../apps/web/services/api");

    expect(
      isValidDemoAdminCredentials(
        "rafaelcornelius@nexus.local",
        "NexusAdmin@2026",
        api.DEMO_ADMIN_EMAIL,
        api.DEMO_ADMIN_PASSWORD
      )
    ).toBe(true);

    api.saveSession(api.DEMO_SESSION);

    await expect(api.fetchCurrentSession()).resolves.toMatchObject({
      user: {
        email: "rafaelcornelius@nexus.local",
        roles: ["ADMIN"]
      }
    });

    api.clearSession();
    expect(api.getSession()).toBeNull();
  });
});
