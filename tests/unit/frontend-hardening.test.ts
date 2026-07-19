import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { goalVisualState } from "../../apps/web/lib/operational-goals";
import { resolveExplicitWeekId } from "../../apps/web/lib/week-selection";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

describe("frontend operational hardening", () => {
  it("renders the target and status returned by the API without reclassifying the KPI", () => {
    const visual = goalVisualState(
      [{ metric: "yield", target: 0.95, comparator: ">=", status: "CRITICAL" }],
      ["yield"],
      (target) => `${target * 100}%`
    );

    expect(visual).toEqual({ status: "CRITICAL", hint: "Meta >= 95%" });
  });

  it("does not invent a status when a KPI has no unambiguous active goal", () => {
    expect(goalVisualState([], ["losses_kg"], String)).toEqual({ hint: "Sem meta ativa configurada." });

    const visual = goalVisualState(
      [
        { metric: "losses_kg", target: 40, comparator: "<=", status: "OK" },
        { metric: "losses_kg", target: 45, comparator: "<=", status: "ATTENTION" }
      ],
      ["losses_kg"],
      String
    );

    expect(visual.status).toBeUndefined();
    expect(visual.hint).toContain("2 metas ativas");
  });

  it("requires an explicit valid week instead of selecting the first API row", () => {
    const weeks = [{ id: "archived-week" }, { id: "open-week" }];

    expect(resolveExplicitWeekId(weeks, "")).toBe("");
    expect(resolveExplicitWeekId(weeks, "missing-week")).toBe("");
    expect(resolveExplicitWeekId(weeks, "open-week")).toBe("open-week");
  });

  it("does not reintroduce fixed KPI thresholds or first-row week fallbacks", () => {
    const files = [
      "apps/web/components/dashboard/executive-dashboard.tsx",
      "apps/web/components/presentations/meeting-mode.tsx",
      "apps/web/app/perdas/page.tsx",
      "apps/web/app/sobrepeso/page.tsx",
      "apps/web/app/paradas/page.tsx",
      "apps/web/app/produtividade/page.tsx"
    ];
    const source = files.map((file) => readFileSync(join(repoRoot, file), "utf-8")).join("\n");

    expect(source).not.toContain("weekRows[0]");
    expect(source).not.toMatch(/lossesTotalKg\s*>\s*50/);
    expect(source).not.toMatch(/overweightPercent\s*>\s*0\.02/);
    expect(source).not.toMatch(/averageYield\s*[<>]=?\s*0\.9/);
    expect(source).not.toMatch(/stoppedTotal\s*>\s*120/);
  });

  it("shows the overweight percentage beside its percentage goal", () => {
    const dashboard = readFileSync(join(repoRoot, "apps/web/components/dashboard/executive-dashboard.tsx"), "utf-8");

    expect(dashboard).toContain('value: formatPercent(kpis.overweightPercent), ...overweightGoal');
    expect(dashboard).not.toContain('value: formatKg(kpis.overweightTotalKg), ...overweightGoal');
  });

  it("keeps the default Next.js cache and avoids unmeasured experimental imports", () => {
    const config = readFileSync(join(repoRoot, "apps/web/next.config.ts"), "utf-8");

    expect(config).not.toContain("config.cache = false");
    expect(config).not.toContain("optimizePackageImports");
    expect(config).not.toContain("experimental:");
  });

  it("builds the operational web container from Next.js standalone output", () => {
    const config = readFileSync(join(repoRoot, "apps/web/next.config.ts"), "utf-8");
    const dockerfile = readFileSync(join(repoRoot, "apps/web/Dockerfile"), "utf-8");

    expect(config).toContain('output: "standalone"');
    expect(config).toContain('source: "/api/:path*"');
    expect(config).toContain("API_INTERNAL_URL");
    expect(dockerfile).toContain(".next/standalone");
    expect(dockerfile).toContain(".next/static");
    expect(dockerfile).toContain('CMD ["node", "apps/web/server.js"]');
    expect(dockerfile).not.toContain("apps/web/out");
  });

  it("publishes the isolated demo with a non-empty preview-only login", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/pages.yml"), "utf-8");
    const api = readFileSync(join(repoRoot, "apps/web/services/api.ts"), "utf-8");

    expect(workflow).toContain('NEXT_PUBLIC_DEMO_MODE: "true"');
    expect(workflow).toMatch(/NEXT_PUBLIC_DEMO_ADMIN_EMAIL:\s*"[^"]+"/);
    expect(workflow).toMatch(/NEXT_PUBLIC_DEMO_ADMIN_PASSWORD:\s*"[^"]+"/);
    expect(api).not.toContain('DEMO_ADMIN_PASSWORD = process.env.NEXT_PUBLIC_DEMO_ADMIN_PASSWORD ?? ""');
  });
});
