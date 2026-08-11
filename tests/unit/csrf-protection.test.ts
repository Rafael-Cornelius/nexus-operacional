import { describe, expect, it } from "vitest";
import { allowsMutationRequest } from "../../apps/api/src/infrastructure/security/csrf-protection";

describe("cookie mutation origin protection", () => {
  const allowedOrigin = "https://nexus.example.com";

  it("allows safe methods and exact same-origin mutations", () => {
    expect(
      allowsMutationRequest({ method: "GET", secFetchSite: "cross-site", allowedOrigin }),
    ).toBe(true);
    expect(
      allowsMutationRequest({
        method: "POST",
        origin: allowedOrigin,
        secFetchSite: "same-origin",
        allowedOrigin,
      }),
    ).toBe(true);
  });

  it("rejects cross-site, sibling-site and forged origins", () => {
    for (const secFetchSite of ["cross-site", "same-site", "none"]) {
      expect(
        allowsMutationRequest({ method: "PATCH", secFetchSite, allowedOrigin }),
      ).toBe(false);
    }
    expect(
      allowsMutationRequest({
        method: "DELETE",
        origin: "https://attacker.example",
        allowedOrigin,
      }),
    ).toBe(false);
  });

  it("keeps non-browser automation possible when browser headers are absent", () => {
    expect(allowsMutationRequest({ method: "POST", allowedOrigin })).toBe(true);
  });
});
