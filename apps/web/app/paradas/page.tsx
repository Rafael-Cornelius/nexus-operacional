"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPostClient, getSession } from "@/services/api";
import { formatKg, formatPercent } from "@/lib/format";

interface WeekRow {
  id: string;
  label: string;
  status: string;
}

interface ReasonRow {
  id: string;
  name: string;
}

interface DowntimeEntryRow {
  id: string;
  date: string;
  stoppedMinutes: string | number;
  stoppedPercent: string | number;
  realKgHour: string | number;
  possibleKgHour: string | number;
  status: string;
  sector?: { code: string };
  reason?: { name: string };
}

function at(date: string, time: string) {
  return `${date}T${time}:00`;
}

export default function DowntimePage() {
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [reasons, setReasons] = useState<ReasonRow[]>([]);
  const [entries, setEntries] = useState<DowntimeEntryRow[]>([]);
  const [weekId, setWeekId] = useState("");
  const [reasonId, setReasonId] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [sector, setSector] = useState<"P1" | "P2">("P1");
  const [productionStart, setProductionStart] = useState("08:00");
  const [productionEnd, setProductionEnd] = useState("16:00");
  const [downtimeStart, setDowntimeStart] = useState("10:00");
  const [downtimeEnd, setDowntimeEnd] = useState("10:20");
  const [producedMassKg, setProducedMassKg] = useState(5000);
  const [message, setMessage] = useState("Carregando paradas da API.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadData(nextWeekId = weekId) {
    const requestedWeek = nextWeekId || weekId;
    if (!session) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const [weekRows, reasonRows] = await Promise.all([
        apiGetClient<WeekRow[]>("/weeks"),
        apiGetClient<ReasonRow[]>("/downtime/reasons")
      ]);
      const selectedWeek = requestedWeek || weekRows.find((week) => week.status !== "CLOSED" && week.status !== "ARCHIVED")?.id || weekRows[0]?.id || "";
      setWeeks(weekRows);
      setReasons(reasonRows);
      setWeekId(selectedWeek);
      setReasonId((current) => current || reasonRows[0]?.id || "");
      if (selectedWeek) {
        const rows = await apiGetClient<DowntimeEntryRow[]>(`/downtime?weekId=${selectedWeek}`);
        setEntries(rows);
      }
      setMessage("Paradas carregadas da API.");
    } catch (error) {
      setWeeks([]);
      setReasons([]);
      setEntries([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar paradas da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData("");
  }, []);

  async function saveDowntime() {
    if (!session || !weekId || !reasonId) {
      setMessage("Entre no sistema e selecione semana/motivo para salvar.");
      return;
    }
    setLoading(true);
    try {
      await apiPostClient(
        "/downtime",
        {
          weekId,
          date,
          sector,
          productionStart: at(date, productionStart),
          productionEnd: at(date, productionEnd),
          downtimeStart: at(date, downtimeStart),
          downtimeEnd: at(date, downtimeEnd),
          producedMassKg,
          downtimeReasonId: reasonId,
          notes: "Parada registrada pela tela operacional."
        }
      );
      await loadData(weekId);
      setMessage("Parada registrada e classificada pelo backend.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao salvar parada.");
    } finally {
      setLoading(false);
    }
  }

  const stoppedTotal = entries.reduce((sum, entry) => sum + Number(entry.stoppedMinutes), 0);
  const averageRealKgHour = entries.length ? entries.reduce((sum, entry) => sum + Number(entry.realKgHour), 0) / entries.length : 0;
  const averagePingandoKgHour = entries.length ? entries.reduce((sum, entry) => sum + Number(entry.possibleKgHour), 0) / entries.length : 0;
  const rows = entries.length
    ? entries.map((entry) => ({
        Data: entry.date.slice(0, 10),
        Setor: entry.sector?.code ?? "-",
        Motivo: entry.reason?.name ?? "-",
        Tempo: `${Number(entry.stoppedMinutes).toLocaleString("pt-BR")} min`,
        "% parada": formatPercent(Number(entry.stoppedPercent)),
        "kg/h real": formatKg(Number(entry.realKgHour)),
        "kg/h pingando": formatKg(Number(entry.possibleKgHour)),
        Status: entry.status
      }))
    : [{ Data: "-", Setor: "-", Motivo: "Nenhuma parada carregada.", Tempo: "-", "% parada": "-", "kg/h real": "-", "kg/h pingando": "-", Status: "-" }];

  return (
    <div className="space-y-6">
      <PageHeader title="Controle de paradas" description="Controle de inicio, termino, motivo, tempo parado, eficiencia e impacto produtivo." />
      <Card>
        <div className="grid gap-4 md:grid-cols-4">
          <Select label="Semana" value={weekId} onChange={setWeekId} options={weeks.map((week) => ({ value: week.id, label: `${week.label} - ${week.status}` }))} />
          <Select label="Motivo" value={reasonId} onChange={setReasonId} options={reasons.map((reason) => ({ value: reason.id, label: reason.name }))} />
          <Select label="Setor" value={sector} onChange={(value) => setSector(value as "P1" | "P2")} options={[{ value: "P1", label: "P1" }, { value: "P2", label: "P2" }]} />
          <Input label="Data" type="date" value={date} onChange={setDate} />
          <Input label="Inicio producao" type="time" value={productionStart} onChange={setProductionStart} />
          <Input label="Fim producao" type="time" value={productionEnd} onChange={setProductionEnd} />
          <Input label="Inicio parada" type="time" value={downtimeStart} onChange={setDowntimeStart} />
          <Input label="Fim parada" type="time" value={downtimeEnd} onChange={setDowntimeEnd} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <NumberInput label="Massas produzidas kg" value={producedMassKg} onChange={setProducedMassKg} />
          <Button type="button" onClick={saveDowntime} disabled={loading}>
            <Save className="size-4" />
            Salvar parada
          </Button>
          <Button type="button" className="border-slate-400/30 bg-white/5" onClick={() => loadData(weekId)} disabled={loading}>
            <RefreshCw className="size-4" />
            Atualizar
          </Button>
        </div>
        <p className="mt-4 text-sm text-slate-300">{message}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Tempo parado" value={`${stoppedTotal.toLocaleString("pt-BR")} min`} status={stoppedTotal > 120 ? "MEDIUM" : "OK"} />
        <StatCard label="Registros" value={String(entries.length)} />
        <StatCard label="kg/h real médio" value={formatKg(averageRealKgHour)} />
        <StatCard label="kg/h pingando médio" value={formatKg(averagePingandoKgHour)} />
        <StatCard label="Status operacional" value={stoppedTotal > 120 ? "Atencao" : "OK"} status={stoppedTotal > 120 ? "ATTENTION" : "OK"} />
      </div>
      <DataTable title="Paradas" rows={rows} />
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <select className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Selecione</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function Input({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return (
    <label className="space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type={type} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="min-w-56 space-y-2">
      <span className="text-xs uppercase text-slate-400">{label}</span>
      <input type="number" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
