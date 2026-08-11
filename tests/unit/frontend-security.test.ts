import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const webRoot = join(repoRoot, "apps/web");

function webFiles(dir = webRoot): string[] {
  return readdirSync(dir).flatMap((name) => {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if ([".next", "out", "node_modules"].includes(name)) return [];
      return webFiles(fullPath);
    }
    return [fullPath];
  });
}

describe("frontend security boundary", () => {
  it("does not ship the workbook-derived legacy JSON in the web app", () => {
    expect(existsSync(join(webRoot, "lib/legacy-data.json"))).toBe(false);
  });

  it("does not import legacy workbook data or expose local admin credentials in frontend source", () => {
    const forbidden = [
      "legacy-data.json",
      "local-admin-session",
      "NEXT_PUBLIC_LOCAL_ADMIN_PASSWORD",
      "NEXT_PUBLIC_ENABLE_LOCAL_ADMIN",
      "window.localStorage",
      "ChangeMe!2026",
      "http://localhost:3333/api"
    ];

    const offenders = webFiles()
      .map((file) => ({ file, text: readFileSync(file, "utf-8") }))
      .flatMap(({ file, text }) =>
        forbidden.filter((pattern) => text.includes(pattern)).map((pattern) => `${relative(repoRoot, file)} -> ${pattern}`)
      );

    expect(offenders).toEqual([]);
  });

  it("uses only HTTP-only cookie sessions in the browser client", () => {
    const apiClient = readFileSync(join(webRoot, "services/api.ts"), "utf-8");
    expect(apiClient).not.toContain("Authorization");
    expect(apiClient).not.toContain("accessToken");
    expect(apiClient).toContain('credentials: "include"');
  });

  it("keeps demo fixtures isolated from operational frontend code", () => {
    expect(existsSync(join(webRoot, "lib/demo-data.ts"))).toBe(false);
    expect(existsSync(join(webRoot, "lib/demo/operational-preview.ts"))).toBe(true);
  });

  it("does not bypass lint or force static export in operational builds", () => {
    const config = readFileSync(join(webRoot, "next.config.ts"), "utf-8");
    expect(config).not.toContain("ignoreDuringBuilds");
    expect(config).toContain('process.env.NEXUS_STATIC_DEMO === "true"');
  });
});
