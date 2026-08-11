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

  it("keeps the public preview isolated from the operational API", async () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const api = await import("../../apps/web/services/api");
    const fallback = { source: "preview" };

    await expect(api.apiGet("/dashboard/kpis", fallback)).resolves.toBe(fallback);
    await expect(api.apiPost("/production", {}, fallback)).resolves.toBe(fallback);
    await expect(api.apiGetClient("/weeks")).rejects.toMatchObject({ status: 503 });
    await expect(api.apiPostClient("/auth/login", {})).rejects.toMatchObject({ status: 503 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
