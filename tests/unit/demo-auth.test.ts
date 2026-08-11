import { describe, expect, it } from "vitest";
import { isValidDemoAdminCredentials } from "../../apps/web/lib/demo-auth";

const email = "rafaelcornelius@nexus.local";
const password = "NexusAdmin@2026";

describe("preview admin authentication", () => {
  it("accepts the configured administrator credentials", () => {
    expect(isValidDemoAdminCredentials(email, password, email, password)).toBe(true);
  });

  it("normalizes email casing and accidental copy spaces", () => {
    expect(isValidDemoAdminCredentials(`  ${email.toUpperCase()}  `, ` ${password} `, email, password)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    expect(isValidDemoAdminCredentials(email, "senha-errada", email, password)).toBe(false);
  });

  it("rejects an incorrect email", () => {
    expect(isValidDemoAdminCredentials("outro@nexus.local", password, email, password)).toBe(false);
  });

  it("rejects empty preview configuration", () => {
    expect(isValidDemoAdminCredentials(email, password, email, "")).toBe(false);
  });
});
