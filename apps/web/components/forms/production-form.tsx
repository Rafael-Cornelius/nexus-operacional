"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, StatusBadge } from "@/components/ui/card";
import { DataTable } from "@/components/tables/data-table";
import { EntryWorkflowActions } from "@/components/workflow/entry-workflow-actions";
import { createDemoProductionEntries, demoWorkflowProducts, demoWorkflowWeek } from "@/lib/demo/workflow-preview";
import { formatCurrency, formatKg, formatPercent } from "@/lib/format";
import type { WorkflowEntry } from "@/lib/operational-workflow";
import { resolveExplicitWeekId } from "@/lib/week-selection";
import { apiGetClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

interface FormState {
  productionOrder: string;
  plannedBatches: number;
  realizedBatches: number;
  packedBoxes: number;
  averagePackageWeightG: number;
  usedReworkKg: number;
  weighingLossKg: number;
  generatedReworkKg: number;
  notes: string;
}

interface ProductRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
  pricePerKg?: string | number;
  defaultSector?: { code: "P1" | "P2" };
  weightConfig?: {
    formula: "BOX_WEIGHT" | "PACKAGE_WEIGHT";
    packageWeightKg: string | number;
    boxWeightKg: string | number;
    packagesPerBox: number;
    massWeightKg: string | number;
    targetPackageWeightG: string | number;
    overweightTolerancePercent: string | number;
  } | null;
}

interface WeekRow {
  id: string;
  label: string;
  year: number;
  month: number;
  weekNumber: number;
  status: string;
}

interface EntryRow extends WorkflowEntry {
  id: string;
  date: string;
  productionOrder: string;
  packedBoxes: string | number;
  producedKg: string | number;
  expectedYieldKg: string | number;
  realYieldPercent: string | number;
  overweightTotalKg: string | number;
  productionCost?: string | number;
  lossesCost?: string | number;
  overweightCost?: string | number;
  status: string;
  product?: { code: string; name: string };
}

interface PreviewState {
  producedKg: number;
  expectedYieldKg: number;
  realYieldPercent: number;
  overweightTotalKg: number;
  overweightPercent: number;
  productionCost: number;
  lossesCost: number;
  overweightCost: number;
  status: string;
  calculationRuleVersions?: Record<string, number>;
}

const EMPTY_PREVIEW: PreviewState = {
  producedKg: 0,
  expectedYieldKg: 0,
  realYieldPercent: 0,
  overweightTotalKg: 0,
  overweightPercent: 0,
  productionCost: 0,
  lossesCost: 0,
  overweightCost: 0,
  status: "OK"
};

const DEMO_PREVIEW: Record<"P1" | "P2", PreviewState> = {
  P1: { producedKg: 5040, expectedYieldKg: 5110, realYieldPercent: 0.986, overweightTotalKg: 7.2, overweightPercent: 0.001429, productionCost: 28224, lossesCost: 31.4, overweightCost: 40.32, status: "OK" },
  P2: { producedKg: 2520, expectedYieldKg: 2590, realYieldPercent: 0.973, overweightTotalKg: 4.1, overweightPercent: 0.001627, productionCost: 14112, lossesCost: 18.2, overweightCost: 22.96, status: "OK" }
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function productWeightConfig(product: ProductRow | undefined) {
  if (!product?.weightConfig) return null;
  return {
    formula: product.weightConfig.formula,
    packageWeightKg: Number(product.weightConfig.packageWeightKg),
    boxWeightKg: Number(product.weightConfig.boxWeightKg),
    packagesPerBox: Number(product.weightConfig.packagesPerBox),
    massWeightKg: Number(product.weightConfig.massWeightKg),
    targetPackageWeightG: Number(product.weightConfig.targetPackageWeightG),
    overweightTolerancePercent: Number(product.weightConfig.overweightTolerancePercent)
  };
}

export function ProductionForm({ sector }: { sector: "P1" | "P2" }) {
  const [state, setState] = useState<FormState>({
    productionOrder: "",
    plannedBatches: 0,
    realizedBatches: 0,
    packedBoxes: 0,
    averagePackageWeightG: 0,
    usedReworkKg: 0,
    weighingLossKg: 0,
    generatedReworkKg: 0,
    notes: ""
  });
  const [date, setDate] = useState(today());
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [productId, setProductId] = useState("");
  const [weekId, setWeekId] = useState("");
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [serverPreview, setServerPreview] = useState<PreviewState | null>(null);
  const [message, setMessage] = useState("Carregando produtos, semanas e lancamentos da API.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  const selectedProduct = products.find((product) => product.id === productId);
  const weightConfig = useMemo(() => productWeightConfig(selectedProduct), [selectedProduct]);
  const preview = serverPreview ?? (DEMO_MODE ? DEMO_PREVIEW[sector] : EMPTY_PREVIEW);

  async function loadReferences() {
    if (!session) return;
    setLoading(true);
    try {
      if (DEMO_MODE) {
        const sectorProducts = demoWorkflowProducts.filter((product) => product.defaultSector.code === sector);
        setProducts(sectorProducts);
        setWeeks([demoWorkflowWeek]);
        setProductId((current) => current || sectorProducts[0]?.id || "");
        setWeekId((current) => current || demoWorkflowWeek.id);
        setMessage("Referências demonstrativas carregadas. As alterações ficam somente neste preview.");
        return;
      }
      const [productRows, weekRows] = await Promise.all([
        apiGetClient<ProductRow[]>("/products?active=true"),
        apiGetClient<WeekRow[]>("/weeks")
      ]);
      const sectorProducts = productRows.filter((product) => product.defaultSector?.code === sector || !product.defaultSector);
      setProducts(sectorProducts);
      setWeeks(weekRows);
      setProductId((current) => current || sectorProducts[0]?.id || "");
      setWeekId((current) => resolveExplicitWeekId(weekRows, current));
      setMessage(weekRows.length ? "Produtos e semanas carregados; selecione a semana do lançamento." : "Produtos carregados; nenhuma semana operacional cadastrada.");
    } catch (error) {
      setProducts([]);
      setWeeks([]);
      setProductId("");
      setWeekId("");
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar referencias da API.");
    } finally {
      setLoading(false);
    }
  }

  async function loadEntries(nextWeekId = weekId) {
    if (!nextWeekId) return;
    if (!session) {
      setEntries([]);
      return;
    }
    if (DEMO_MODE) {
      setEntries((current) => current.length ? current : createDemoProductionEntries(sector));
      setMessage("Lançamentos demonstrativos carregados; o workflow funciona localmente.");
      return;
    }
    try {
      const query = new URLSearchParams({ sector, weekId: nextWeekId });
      const data = await apiGetClient<EntryRow[]>(`/production?${query.toString()}`);
      setEntries(data);
    } catch (error) {
      setEntries([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar lancamentos da API.");
    }
  }

  useEffect(() => {
    loadReferences();
  }, []);

  useEffect(() => {
    loadEntries(weekId);
  }, [weekId]);

  useEffect(() => {
    if (DEMO_MODE || !selectedProduct?.weightConfig || !weightConfig) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const response = await apiPostClient<PreviewState>("/production/preview", {
          sector,
          plannedBatches: state.plannedBatches,
          realizedBatches: state.realizedBatches,
          usedReworkKg: state.usedReworkKg,
          packedBoxes: state.packedBoxes,
          weighingLossKg: state.weighingLossKg,
          generatedReworkKg: state.generatedReworkKg,
          averagePackageWeightG: state.averagePackageWeightG,
          weightConfig,
          pricePerKg: Number(selectedProduct.pricePerKg ?? 0)
        });
        if (active) setServerPreview(response);
      } catch {
        if (active) setServerPreview(null);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [sector, selectedProduct, state, weightConfig]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((current) => ({ ...current, [key]: value }));
    setServerPreview(null);
  }

  async function validateWithBackend() {
    if (DEMO_MODE) {
      setServerPreview(DEMO_PREVIEW[sector]);
      setMessage("Preview demonstrativo usa valores isolados; cálculos operacionais existem somente no backend.");
      return;
    }
    if (!weightConfig) {
      setServerPreview(null);
      setMessage("Produto sem configuração de peso; cálculo bloqueado para revisão.");
      return;
    }
    setLoading(true);
    try {
      const response = await apiPostClient<PreviewState>("/production/preview", {
        sector,
        plannedBatches: state.plannedBatches,
        realizedBatches: state.realizedBatches,
        usedReworkKg: state.usedReworkKg,
        packedBoxes: state.packedBoxes,
        weighingLossKg: state.weighingLossKg,
        generatedReworkKg: state.generatedReworkKg,
        averagePackageWeightG: state.averagePackageWeightG,
        weightConfig,
        pricePerKg: Number(selectedProduct?.pricePerKg ?? 0)
      });
      setServerPreview(response);
      setMessage("Calculo validado pela API de dominio.");
    } catch (caught) {
      setServerPreview(null);
      setMessage(caught instanceof Error ? caught.message : "Nao foi possivel validar o calculo na API.");
    } finally {
      setLoading(false);
    }
  }

  async function saveEntry() {
    if (!session) {
      setMessage("Entre no sistema para salvar lancamentos reais.");
      return;
    }
    if (!weekId || !productId) {
      setMessage("Selecione uma semana e um produto carregados do banco.");
      return;
    }

    if (DEMO_MODE) {
      const demoEntry: EntryRow = {
        id: `demo-production-${sector}-${Date.now()}`,
        date: `${date}T00:00:00.000Z`,
        productionOrder: state.productionOrder || `${sector}-NOVA-OP`,
        packedBoxes: state.packedBoxes,
        producedKg: preview.producedKg,
        expectedYieldKg: preview.expectedYieldKg,
        realYieldPercent: preview.realYieldPercent,
        overweightTotalKg: preview.overweightTotalKg,
        productionCost: preview.productionCost,
        lossesCost: preview.lossesCost,
        overweightCost: preview.overweightCost,
        status: preview.status,
        product: selectedProduct ? { code: selectedProduct.code, name: selectedProduct.name } : undefined,
        workflowStatus: "DRAFT",
        version: 1
      };
      setEntries((current) => [demoEntry, ...current]);
      setMessage("Rascunho criado localmente. Use Enviar para iniciar a aprovação demonstrativa.");
      return;
    }

    setLoading(true);
    try {
      await apiPostClient(
        "/production",
        {
          weekId,
          sector,
          date,
          productId,
          productionOrder: state.productionOrder,
          plannedBatches: state.plannedBatches,
          realizedBatches: state.realizedBatches,
          usedReworkKg: state.usedReworkKg,
          packedBoxes: state.packedBoxes,
          weighingLossKg: state.weighingLossKg,
          generatedReworkKg: state.generatedReworkKg,
          averagePackageWeightG: state.averagePackageWeightG,
          notes: state.notes
        }
      );
      setMessage("Lancamento salvo no banco e recalculado pelo backend.");
      await loadEntries(weekId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar lancamento.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Lancamento diario {sector}</h2>
              <p className="text-sm text-slate-400">Produto, semana e gravacao usam a API autenticada quando disponivel.</p>
            </div>
            <StatusBadge status={preview.status} />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <SelectField label="Semana" value={weekId} onChange={setWeekId} options={weeks.map((week) => ({ value: week.id, label: `${week.label} - ${week.status}` }))} />
            <SelectField label="Produto" value={productId} onChange={setProductId} options={products.map((product) => ({ value: product.id, label: `${product.code} - ${product.name}` }))} />
            <Field label="Data" type="date" value={date} onChange={setDate} />
            <Field label="OP" value={state.productionOrder} onChange={(value) => update("productionOrder", value)} />
            <NumberField label="Planejado bat." value={state.plannedBatches} onChange={(value) => update("plannedBatches", value)} />
            <NumberField label="Realizado bat." value={state.realizedBatches} onChange={(value) => update("realizedBatches", value)} />
            <NumberField label="Caixas embaladas" value={state.packedBoxes} onChange={(value) => update("packedBoxes", value)} />
            <NumberField label="Peso medio pacote g" value={state.averagePackageWeightG} onChange={(value) => update("averagePackageWeightG", value)} />
            {sector === "P1" ? <NumberField label="Reforma utilizada kg" value={state.usedReworkKg} onChange={(value) => update("usedReworkKg", value)} /> : null}
            <NumberField label="Perda de pesagem kg" value={state.weighingLossKg} onChange={(value) => update("weighingLossKg", value)} />
            <NumberField label="Reforma gerada kg" value={state.generatedReworkKg} onChange={(value) => update("generatedReworkKg", value)} />
            <Field label="Observações" value={state.notes} onChange={(value) => update("notes", value)} />
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button type="button" onClick={saveEntry} disabled={loading}>
              <Save className="size-4" />
              {loading ? "Processando..." : "Salvar lancamento"}
            </Button>
            <Button type="button" className="border-slate-400/30 bg-white/5" onClick={validateWithBackend} disabled={loading}>
              <RefreshCw className="size-4" />
              Validar calculo
            </Button>
            <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => setServerPreview(null)}>
              <RotateCcw className="size-4" />
              Limpar previa
            </Button>
          </div>
          <p className="mt-4 rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm text-slate-300">{message}</p>
        </Card>

        <Card>
          <h2 className="mb-4 font-semibold">Previa tecnica</h2>
          <Metric label="Total produzido" value={formatKg(preview.producedKg)} />
          <Metric label="Rendimento esperado" value={formatKg(preview.expectedYieldKg)} />
          <Metric label="Rendimento real" value={formatPercent(preview.realYieldPercent)} />
          <Metric label="Sobrepeso total" value={formatKg(preview.overweightTotalKg)} />
          <Metric label="Sobrepeso %" value={formatPercent(preview.overweightPercent)} />
          <Metric label="Custo produção" value={formatCurrency(preview.productionCost)} />
          <Metric label="Custo perdas" value={formatCurrency(preview.lossesCost)} />
          <Metric label="Custo sobrepeso" value={formatCurrency(preview.overweightCost)} />
        </Card>
      </div>

      <DataTable
        title={`Lancamentos ${sector}`}
        rows={
          entries.length
            ? entries.map((entry) => ({
                Data: entry.date.slice(0, 10),
                Produto: entry.product ? `${entry.product.code} - ${entry.product.name}` : "-",
                OP: entry.productionOrder,
                Caixas: Number(entry.packedBoxes).toLocaleString("pt-BR"),
                Produzido: formatKg(Number(entry.producedKg)),
                Rendimento: formatPercent(Number(entry.realYieldPercent)),
                Sobrepeso: formatKg(Number(entry.overweightTotalKg)),
                "Custo produção": formatCurrency(Number(entry.productionCost ?? 0)),
                "Custo perdas": formatCurrency(Number(entry.lossesCost ?? 0)),
                "Custo sobrepeso": formatCurrency(Number(entry.overweightCost ?? 0)),
                Status: entry.status,
                Fluxo: (
                  <EntryWorkflowActions
                    entry={entry}
                    resource="production"
                    roles={session?.user.roles ?? []}
                    actorId={session?.user.id}
                    demo={DEMO_MODE}
                    disabled={loading}
                    onChanged={async (updated) => {
                      if (DEMO_MODE) setEntries((current) => current.map((item) => item.id === updated.id ? updated : item));
                      else await loadEntries(weekId);
                    }}
                    onReload={() => loadEntries(weekId)}
                    onMessage={setMessage}
                  />
                )
              }))
            : [{ Data: "-", Produto: "Nenhum lancamento carregado para a semana selecionada.", OP: "-", Caixas: "-", Produzido: "-", Rendimento: "-", Sobrepeso: "-", "Custo produção": "-", "Custo perdas": "-", "Custo sobrepeso": "-", Status: "-", Fluxo: <span>-</span> }]
        }
      />
    </div>
  );
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type={type} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <select className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type="number" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-[var(--line)] py-3 last:border-0">
      <p className="text-xs uppercase text-slate-400">{label}</p>
      <strong className="mt-1 block text-xl">{value}</strong>
    </div>
  );
}
