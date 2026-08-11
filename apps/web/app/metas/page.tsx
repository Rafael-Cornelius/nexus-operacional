"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, CopyPlus, History, RefreshCw, Save, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { resolveExplicitWeekId } from "@/lib/week-selection";
import { apiGetClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

type GoalWorkflowStatus = "DRAFT" | "APPROVED" | "RETIRED";

interface NamedReference { id: string; code: string; name: string }
interface GoalRow {
  id: string;
  seriesId: string;
  version: number;
  name: string;
  metric: string;
  sectorCode?: "P1" | "P2" | null;
  lineId?: string | null;
  equipmentId?: string | null;
  shiftId?: string | null;
  productId?: string | null;
  targetValue: string;
  comparator: string;
  measurementUnit?: string | null;
  cadence: "DAILY" | "WEEKLY";
  startsOn?: string | null;
  endsOn?: string | null;
  workflowStatus: GoalWorkflowStatus;
  createdBy?: string | null;
  currentValue?: number | null;
  progress?: number | null;
  status?: string | null;
  action?: string;
  responsible?: { id: string; name: string; email: string } | null;
  approver?: { id: string; name: string; email: string } | null;
  line?: NamedReference | null;
  equipment?: NamedReference | null;
  shift?: NamedReference | null;
  product?: NamedReference | null;
}

interface GoalReferences {
  sectors: Array<{ code: "P1" | "P2"; name: string }>;
  lines: Array<NamedReference & { sector: { code: "P1" | "P2" } }>;
  equipment: Array<NamedReference & { productionLineId: string; productionLine: { sector: { code: "P1" | "P2" } } }>;
  shifts: NamedReference[];
  products: Array<NamedReference & { defaultSector: { code: "P1" | "P2" } }>;
  users: Array<{ id: string; name: string; email: string }>;
}

interface WeekRow { id: string; label: string; status: string }

interface GoalForm {
  name: string;
  metric: string;
  sectorCode: string;
  lineId: string;
  equipmentId: string;
  shiftId: string;
  productId: string;
  targetValue: string;
  comparator: string;
  measurementUnit: string;
  cadence: "DAILY" | "WEEKLY";
  startsOn: string;
  endsOn: string;
  responsibleId: string;
  reason: string;
}

const emptyReferences: GoalReferences = { sectors: [], lines: [], equipment: [], shifts: [], products: [], users: [] };
const emptyForm: GoalForm = {
  name: "",
  metric: "",
  sectorCode: "",
  lineId: "",
  equipmentId: "",
  shiftId: "",
  productId: "",
  targetValue: "",
  comparator: "",
  measurementUnit: "",
  cadence: "WEEKLY",
  startsOn: "",
  endsOn: "",
  responsibleId: "",
  reason: ""
};

export default function GoalsPage() {
  const session = useMemo(() => getSession(), []);
  const canManage = session?.user.roles.some((role) => role === "ADMIN" || role === "MANAGER") ?? false;
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [references, setReferences] = useState<GoalReferences>(emptyReferences);
  const [weekId, setWeekId] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [seriesFilter, setSeriesFilter] = useState("");
  const [editingId, setEditingId] = useState("");
  const [form, setForm] = useState<GoalForm>(emptyForm);
  const [workflowReason, setWorkflowReason] = useState("");
  const [message, setMessage] = useState("Aguardando login para carregar metas reais.");
  const [loading, setLoading] = useState(false);

  const availableLines = useMemo(
    () => references.lines.filter((line) => !form.sectorCode || line.sector.code === form.sectorCode),
    [references.lines, form.sectorCode]
  );
  const availableEquipment = useMemo(
    () => references.equipment.filter((item) =>
      (!form.sectorCode || item.productionLine.sector.code === form.sectorCode)
      && (!form.lineId || item.productionLineId === form.lineId)),
    [references.equipment, form.sectorCode, form.lineId]
  );

  async function loadGoals(nextWeekId = weekId, nextStatus = statusFilter, nextSeries = seriesFilter) {
    if (DEMO_MODE) {
      setGoals([]);
      setMessage("Preview isolado não inventa metas. Conecte API operacional para governar alvos reais.");
      return;
    }
    if (!session) return;
    setLoading(true);
    try {
      const [weekRows, referenceRows] = await Promise.all([
        apiGetClient<WeekRow[]>("/weeks"),
        canManage ? apiGetClient<GoalReferences>("/goals/references") : Promise.resolve(emptyReferences)
      ]);
      const selectedWeek = resolveExplicitWeekId(weekRows, nextWeekId);
      const params = new URLSearchParams();
      if (selectedWeek) params.set("weekId", selectedWeek);
      if (nextStatus) params.set("status", nextStatus);
      if (nextSeries) params.set("seriesId", nextSeries);
      const rows = await apiGetClient<GoalRow[]>(`/goals${params.size ? `?${params}` : ""}`);
      setGoals(rows);
      setWeeks(weekRows);
      setReferences(referenceRows);
      setWeekId(selectedWeek);
      setStatusFilter(nextStatus);
      setSeriesFilter(nextSeries);
      setMessage(rows.length ? `${rows.length} versão(ões) carregada(s).` : "Nenhuma meta encontrada para os filtros.");
    } catch (error) {
      setGoals([]);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar metas da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadGoals();
  }, []);

  function updateForm<K extends keyof GoalForm>(field: K, value: GoalForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function resetForm() {
    setEditingId("");
    setForm(emptyForm);
  }

  function prepareVersion(goal: GoalRow) {
    setEditingId(goal.id);
    setForm({
      name: goal.name,
      metric: goal.metric,
      sectorCode: goal.sectorCode ?? "",
      lineId: goal.lineId ?? "",
      equipmentId: goal.equipmentId ?? "",
      shiftId: goal.shiftId ?? "",
      productId: goal.productId ?? "",
      targetValue: goal.targetValue,
      comparator: goal.comparator,
      measurementUnit: goal.measurementUnit ?? "",
      cadence: goal.cadence,
      startsOn: goal.startsOn?.slice(0, 10) ?? "",
      endsOn: goal.endsOn?.slice(0, 10) ?? "",
      responsibleId: goal.responsible?.id ?? "",
      reason: ""
    });
    setMessage(`Nova versão da meta ${goal.name}. Métrica e escopo permanecem imutáveis na série.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveGoal() {
    if (!canManage) {
      setMessage("Perfil possui acesso somente para consulta.");
      return;
    }
    if (!form.name || !form.metric || !form.targetValue || !form.comparator || !form.measurementUnit || !form.startsOn || !form.responsibleId) {
      setMessage("Preencha nome, métrica, alvo, comparador, unidade, vigência inicial e responsável.");
      return;
    }
    if (form.reason.trim().length < 10) {
      setMessage("Motivo da criação ou versão deve possuir ao menos 10 caracteres.");
      return;
    }
    setLoading(true);
    try {
      if (editingId) {
        await apiPostClient(`/goals/${editingId}/versions`, {
          name: form.name,
          targetValue: form.targetValue,
          comparator: form.comparator,
          measurementUnit: form.measurementUnit,
          cadence: form.cadence,
          startsOn: form.startsOn,
          endsOn: form.endsOn || null,
          responsibleId: form.responsibleId,
          reason: form.reason
        });
      } else {
        await apiPostClient("/goals", {
          name: form.name,
          metric: form.metric,
          sectorCode: form.sectorCode || null,
          lineId: form.lineId || null,
          equipmentId: form.equipmentId || null,
          shiftId: form.shiftId || null,
          productId: form.productId || null,
          targetValue: form.targetValue,
          comparator: form.comparator,
          measurementUnit: form.measurementUnit,
          cadence: form.cadence,
          startsOn: form.startsOn,
          endsOn: form.endsOn || null,
          responsibleId: form.responsibleId,
          reason: form.reason
        });
      }
      const action = editingId ? "Nova versão DRAFT criada." : "Meta DRAFT criada.";
      resetForm();
      await loadGoals();
      setMessage(`${action} Aprovação humana ainda necessária.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar meta.");
    } finally {
      setLoading(false);
    }
  }

  async function workflow(goal: GoalRow, action: "approve" | "retire") {
    if (!canManage) return;
    if (workflowReason.trim().length < 10) {
      setMessage("Informe motivo de workflow com ao menos 10 caracteres.");
      return;
    }
    const verb = action === "approve" ? "aprovar" : "retirar";
    if (!window.confirm(`Confirma ${verb} ${goal.name}, versão ${goal.version}?`)) return;
    setLoading(true);
    try {
      await apiPostClient(`/goals/${goal.id}/${action}`, { reason: workflowReason });
      setWorkflowReason("");
      await loadGoals();
      setMessage(action === "approve" ? "Meta aprovada e disponível ao dashboard." : "Meta retirada; histórico preservado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha no workflow da meta.");
    } finally {
      setLoading(false);
    }
  }

  const approved = goals.filter((goal) => goal.workflowStatus === "APPROVED").length;
  const drafts = goals.filter((goal) => goal.workflowStatus === "DRAFT").length;
  const retired = goals.filter((goal) => goal.workflowStatus === "RETIRED").length;

  return (
    <div className="space-y-6">
      <PageHeader title="Metas e limites" description="Metas versionadas, temporais e aprovadas. Dashboard ignora rascunhos e versões retiradas." />

      {canManage ? (
        <Card className="space-y-4">
          <div>
            <h3 className="font-semibold">{editingId ? "Criar nova versão" : "Nova meta"}</h3>
            <p className="mt-1 text-sm text-slate-400">
              Salvar cria DRAFT. Aprovação ocorre em ação separada. Versões existentes nunca são sobrescritas.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Input label="Nome" value={form.name} onChange={(value) => updateForm("name", value)} />
            <Select label="Métrica" value={form.metric} onChange={(value) => updateForm("metric", value)} disabled={Boolean(editingId)} options={[
              { value: "", label: "Selecione" },
              { value: "yield", label: "Rendimento" },
              { value: "overweight", label: "Sobrepeso" },
              { value: "losses_kg", label: "Perdas kg" },
              { value: "downtime_minutes", label: "Paradas min" },
              { value: "produced_kg", label: "Produção kg" }
            ]} />
            <Input label="Valor alvo" type="number" step="0.000001" min="0" value={form.targetValue} onChange={(value) => updateForm("targetValue", value)} />
            <Select label="Comparador" value={form.comparator} onChange={(value) => updateForm("comparator", value)} options={[
              { value: "", label: "Selecione" }, { value: "<=", label: "<=" }, { value: ">=", label: ">=" },
              { value: "<", label: "<" }, { value: ">", label: ">" }, { value: "=", label: "=" }
            ]} />
            <Input label="Unidade" value={form.measurementUnit} onChange={(value) => updateForm("measurementUnit", value)} placeholder="Ex.: %, kg, min" />
            <Select label="Frequência" value={form.cadence} onChange={(value) => updateForm("cadence", value as GoalForm["cadence"])} options={[
              { value: "DAILY", label: "Diária" }, { value: "WEEKLY", label: "Semanal" }
            ]} />
            <Select label="Setor" value={form.sectorCode} onChange={(value) => {
              updateForm("sectorCode", value);
              updateForm("lineId", "");
              updateForm("equipmentId", "");
            }} disabled={Boolean(editingId)} options={[
              { value: "", label: "Global" }, ...references.sectors.map((sector) => ({ value: sector.code, label: `${sector.code} · ${sector.name}` }))
            ]} />
            <Select label="Linha" value={form.lineId} onChange={(value) => {
              updateForm("lineId", value);
              updateForm("equipmentId", "");
            }} disabled={Boolean(editingId)} options={[
              { value: "", label: "Todas" }, ...availableLines.map((line) => ({ value: line.id, label: `${line.code} · ${line.name}` }))
            ]} />
            <Select label="Equipamento" value={form.equipmentId} onChange={(value) => updateForm("equipmentId", value)} disabled={Boolean(editingId)} options={[
              { value: "", label: "Todos" }, ...availableEquipment.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` }))
            ]} />
            <Select label="Turno" value={form.shiftId} onChange={(value) => updateForm("shiftId", value)} disabled={Boolean(editingId)} options={[
              { value: "", label: "Todos" }, ...references.shifts.map((shift) => ({ value: shift.id, label: `${shift.code} · ${shift.name}` }))
            ]} />
            <Select label="Produto" value={form.productId} onChange={(value) => updateForm("productId", value)} disabled={Boolean(editingId)} options={[
              { value: "", label: "Todos" }, ...references.products.map((product) => ({ value: product.id, label: `${product.code} · ${product.name}` }))
            ]} />
            <Select label="Responsável" value={form.responsibleId} onChange={(value) => updateForm("responsibleId", value)} options={[
              { value: "", label: "Selecione" }, ...references.users.map((user) => ({ value: user.id, label: `${user.name} · ${user.email}` }))
            ]} />
            <Input label="Vigência inicial" type="date" value={form.startsOn} onChange={(value) => updateForm("startsOn", value)} />
            <Input label="Vigência final" type="date" value={form.endsOn} onChange={(value) => updateForm("endsOn", value)} />
            <Input label="Motivo da versão" value={form.reason} onChange={(value) => updateForm("reason", value)} placeholder="Mínimo 10 caracteres" />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => void saveGoal()} disabled={loading}>
              <Save className="size-4" />
              {editingId ? "Criar versão DRAFT" : "Criar meta DRAFT"}
            </Button>
            {editingId ? <Button type="button" className="border-slate-400/30 bg-white/5" onClick={resetForm}><X className="size-4" />Cancelar versão</Button> : null}
          </div>
        </Card>
      ) : null}

      <Card className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
          <Select label="Semana de avaliação" value={weekId} onChange={(value) => void loadGoals(value, statusFilter, seriesFilter)} options={[
            { value: "", label: "Período atual" }, ...weeks.map((week) => ({ value: week.id, label: `${week.label} · ${week.status}` }))
          ]} />
          <Select label="Workflow" value={statusFilter} onChange={(value) => void loadGoals(weekId, value, seriesFilter)} options={[
            { value: "", label: "Todos" }, { value: "DRAFT", label: "DRAFT" }, { value: "APPROVED", label: "APPROVED" }, { value: "RETIRED", label: "RETIRED" }
          ]} />
          {canManage ? <Input label="Motivo de aprovação/retirada" value={workflowReason} onChange={setWorkflowReason} placeholder="Mínimo 10 caracteres" /> : null}
          <div className="flex items-end gap-2">
            <Button type="button" onClick={() => void loadGoals()} disabled={loading}><RefreshCw className="size-4" />Atualizar</Button>
            {seriesFilter ? <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => void loadGoals(weekId, statusFilter, "")}><X className="size-4" />Todas</Button> : null}
          </div>
        </div>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Aprovadas" value={String(approved)} status={approved ? "OK" : undefined} />
        <StatCard label="Aguardando aprovação" value={String(drafts)} status={drafts ? "ATTENTION" : undefined} />
        <StatCard label="Retiradas" value={String(retired)} />
      </div>

      <DataTable
        title={seriesFilter ? "Histórico da série" : "Metas versionadas"}
        rows={goals.map((goal) => ({
          Meta: <div><strong>{goal.name}</strong><div className="text-xs text-slate-400">v{goal.version}</div></div>,
          Workflow: goal.workflowStatus,
          Métrica: goal.metric,
          Escopo: formatScope(goal),
          Alvo: `${goal.comparator} ${goal.targetValue} ${goal.measurementUnit ?? "unidade não definida"}`,
          Vigência: `${goal.startsOn?.slice(0, 10) ?? "não definida"} até ${goal.endsOn?.slice(0, 10) ?? "aberta"}`,
          Responsável: goal.responsible?.name ?? "não definido",
          Aprovador: goal.approver?.name ?? "-",
          Atual: goal.currentValue === null || goal.currentValue === undefined ? "-" : Number(goal.currentValue).toLocaleString("pt-BR", { maximumFractionDigits: 6 }),
          Indicador: goal.status ?? "-",
          Ações: (
            <div className="flex min-w-52 flex-wrap gap-2">
              <SmallButton onClick={() => void loadGoals(weekId, statusFilter, goal.seriesId)}><History className="size-3" />Histórico</SmallButton>
              {canManage ? <SmallButton onClick={() => prepareVersion(goal)}><CopyPlus className="size-3" />Nova versão</SmallButton> : null}
              {canManage && goal.workflowStatus === "DRAFT" && goal.createdBy !== session?.user.id && goal.responsible?.id !== session?.user.id ? <SmallButton onClick={() => void workflow(goal, "approve")}><CheckCircle2 className="size-3" />Aprovar</SmallButton> : null}
              {canManage && goal.workflowStatus === "DRAFT" && (goal.createdBy === session?.user.id || goal.responsible?.id === session?.user.id) ? <span className="self-center text-xs text-amber-200">Outro gestor deve aprovar</span> : null}
              {canManage && goal.workflowStatus !== "RETIRED" ? <SmallButton onClick={() => void workflow(goal, "retire")}><Archive className="size-3" />Retirar</SmallButton> : null}
            </div>
          )
        }))}
      />
    </div>
  );
}

function formatScope(goal: GoalRow) {
  const parts = [
    goal.sectorCode ? `Setor ${goal.sectorCode}` : "Global",
    goal.line ? `Linha ${goal.line.code}` : null,
    goal.equipment ? `Equip. ${goal.equipment.code}` : null,
    goal.shift ? `Turno ${goal.shift.code}` : null,
    goal.product ? `Produto ${goal.product.code}` : null
  ].filter(Boolean);
  return parts.join(" · ");
}

function Select({ label, value, onChange, options, disabled = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <select disabled={disabled} className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm outline-none focus:border-cyan-300/60 disabled:opacity-60" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, step, min }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  step?: string;
  min?: string;
}) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type={type} step={step} min={min} placeholder={placeholder} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SmallButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded border border-cyan-300/20 bg-cyan-300/10 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-300/20">{children}</button>;
}
