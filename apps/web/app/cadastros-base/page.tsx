"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, RefreshCw, RotateCcw, Save, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiDeleteClient, apiGetClient, apiPatchClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

type SectorCode = "P1" | "P2";
type LossTypeCode = "PACKAGING" | "BOX" | "ORGANIC" | "MACHINE" | "WEIGHING" | "OVERWEIGHT" | "OTHER";

interface CountMap {
  [key: string]: number;
}

interface SectorRow {
  id: string;
  code: SectorCode;
  name: string;
  description?: string | null;
  _count?: CountMap;
}

interface LineRow {
  id: string;
  sectorId: string;
  code: string;
  name: string;
  active: boolean;
  deletedAt?: string | null;
  sector: SectorRow;
  _count?: CountMap;
}

interface LossTypeRow {
  id: string;
  code: LossTypeCode;
  name: string;
  defaultGoalKg?: string | number | null;
  active: boolean;
  _count?: CountMap;
}

interface DowntimeReasonRow {
  id: string;
  name: string;
  active: boolean;
  _count?: CountMap;
}

interface ReferenceOverview {
  sectors: SectorRow[];
  lines: LineRow[];
  lossTypes: LossTypeRow[];
  downtimeReasons: DowntimeReasonRow[];
}

const emptyOverview: ReferenceOverview = { sectors: [], lines: [], lossTypes: [], downtimeReasons: [] };
const demoOverview: ReferenceOverview = {
  sectors: [
    { id: "11111111-1111-4111-8111-111111111111", code: "P1", name: "Setor P1 demonstrativo", _count: { lines: 1 } },
    { id: "22222222-2222-4222-8222-222222222222", code: "P2", name: "Setor P2 demonstrativo", _count: { lines: 1 } }
  ],
  lines: [
    { id: "33333333-3333-4333-8333-333333333333", sectorId: "11111111-1111-4111-8111-111111111111", code: "LINHA-P1", name: "Linha P1 demonstrativa", active: true, sector: { id: "11111111-1111-4111-8111-111111111111", code: "P1", name: "Setor P1 demonstrativo" } },
    { id: "44444444-4444-4444-8444-444444444444", sectorId: "22222222-2222-4222-8222-222222222222", code: "LINHA-P2", name: "Linha P2 demonstrativa", active: true, sector: { id: "22222222-2222-4222-8222-222222222222", code: "P2", name: "Setor P2 demonstrativo" } }
  ],
  lossTypes: [{ id: "55555555-5555-4555-8555-555555555555", code: "PACKAGING", name: "Embalagem demonstrativa", active: true }],
  downtimeReasons: [{ id: "66666666-6666-4666-8666-666666666666", name: "Motivo demonstrativo", active: true }]
};

const lossTypeCodes: Array<{ value: LossTypeCode; label: string }> = [
  { value: "WEIGHING", label: "Pesagem" },
  { value: "PACKAGING", label: "Embalagem/filme" },
  { value: "BOX", label: "Caixa" },
  { value: "ORGANIC", label: "Orgânica" },
  { value: "MACHINE", label: "Máquina" },
  { value: "OVERWEIGHT", label: "Sobrepeso" },
  { value: "OTHER", label: "Outra" }
];

export default function BaseRegistrationsPage() {
  const session = useMemo(() => getSession(), []);
  const canManage = session?.user.roles.includes("ADMIN") ?? false;
  const [data, setData] = useState<ReferenceOverview>(emptyOverview);
  const [message, setMessage] = useState("Carregando cadastros-base.");
  const [loading, setLoading] = useState(false);
  const [sectorId, setSectorId] = useState("");
  const [sectorCode, setSectorCode] = useState<SectorCode>("P1");
  const [sectorName, setSectorName] = useState("");
  const [sectorDescription, setSectorDescription] = useState("");
  const [lineId, setLineId] = useState("");
  const [lineSectorId, setLineSectorId] = useState("");
  const [lineCode, setLineCode] = useState("");
  const [lineName, setLineName] = useState("");
  const [lossTypeId, setLossTypeId] = useState("");
  const [lossTypeCode, setLossTypeCode] = useState<LossTypeCode>("PACKAGING");
  const [lossTypeName, setLossTypeName] = useState("");
  const [lossGoalKg, setLossGoalKg] = useState("");
  const [reasonId, setReasonId] = useState("");
  const [reasonName, setReasonName] = useState("");

  async function load() {
    if (DEMO_MODE) {
      setData({
        sectors: demoOverview.sectors.map((row) => ({ ...row })),
        lines: demoOverview.lines.map((row) => ({ ...row, sector: { ...row.sector } })),
        lossTypes: demoOverview.lossTypes.map((row) => ({ ...row })),
        downtimeReasons: demoOverview.downtimeReasons.map((row) => ({ ...row }))
      });
      setMessage("Preview isolado: exemplos locais. Banco operacional permanece vazio.");
      return;
    }
    if (!session) {
      setData(emptyOverview);
      setMessage("Entre no sistema para consultar os cadastros-base.");
      return;
    }
    setLoading(true);
    try {
      const overview = await apiGetClient<ReferenceOverview>("/reference-data");
      setData(overview);
      setLineSectorId((current) => current || overview.sectors[0]?.id || "");
      setMessage("Cadastros-base carregados da API e prontos para configuração.");
    } catch (error) {
      setData(emptyOverview);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar os cadastros-base.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function run(action: () => Promise<void>, success: string) {
    if (!canManage) {
      setMessage("Somente ADMIN pode alterar cadastros-base.");
      return;
    }
    setLoading(true);
    try {
      await action();
      if (!DEMO_MODE) await load();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível concluir a operação.");
    } finally {
      setLoading(false);
    }
  }

  function resetSector() {
    setSectorId("");
    setSectorCode("P1");
    setSectorName("");
    setSectorDescription("");
  }

  async function saveSector() {
    if (!sectorName.trim()) {
      setMessage("Informe nome do setor.");
      return;
    }
    await run(async () => {
      const payload = { name: sectorName.trim(), description: sectorDescription.trim() || null };
      if (DEMO_MODE) {
        setData((current) => ({
          ...current,
          sectors: sectorId
            ? current.sectors.map((row) => row.id === sectorId ? { ...row, ...payload } : row)
            : [...current.sectors, { id: crypto.randomUUID(), code: sectorCode, ...payload }]
        }));
      } else if (sectorId) {
        await apiPatchClient(`/reference-data/sectors/${sectorId}`, payload);
      } else {
        await apiPostClient("/reference-data/sectors", { code: sectorCode, ...payload });
      }
      resetSector();
    }, sectorId ? "Setor atualizado e auditado." : "Setor criado e auditado.");
  }

  async function removeSector(row: SectorRow) {
    if (!window.confirm(`Remover o setor ${row.code}? Somente setores sem vínculos podem ser removidos.`)) return;
    await run(async () => {
      if (DEMO_MODE) setData((current) => ({ ...current, sectors: current.sectors.filter((item) => item.id !== row.id) }));
      else await apiDeleteClient(`/reference-data/sectors/${row.id}`);
      if (sectorId === row.id) resetSector();
    }, "Setor sem vínculos removido e auditado.");
  }

  function resetLine() {
    setLineId("");
    setLineSectorId(data.sectors[0]?.id ?? "");
    setLineCode("");
    setLineName("");
  }

  async function saveLine() {
    if (!lineSectorId || !lineCode.trim() || !lineName.trim()) {
      setMessage("Informe setor, código e nome da linha.");
      return;
    }
    await run(async () => {
      const payload = { sectorId: lineSectorId, code: lineCode.trim().toUpperCase(), name: lineName.trim(), active: true };
      if (DEMO_MODE) {
        const sector = data.sectors.find((row) => row.id === lineSectorId);
        if (!sector) throw new Error("Setor demonstrativo não encontrado.");
        setData((current) => ({
          ...current,
          lines: lineId
            ? current.lines.map((row) => row.id === lineId ? { ...row, ...payload, sector } : row)
            : [...current.lines, { id: crypto.randomUUID(), ...payload, sector }]
        }));
      } else if (lineId) {
        await apiPatchClient(`/reference-data/lines/${lineId}`, payload);
      } else {
        await apiPostClient("/reference-data/lines", payload);
      }
      resetLine();
    }, lineId ? "Linha atualizada e auditada." : "Linha criada e auditada.");
  }

  async function deactivateLine(row: LineRow) {
    if (!window.confirm(`Desativar a linha ${row.code}? Equipamentos ativos devem ser desativados primeiro.`)) return;
    await run(async () => {
      if (DEMO_MODE) setData((current) => ({ ...current, lines: current.lines.map((item) => item.id === row.id ? { ...item, active: false, deletedAt: new Date().toISOString() } : item) }));
      else await apiDeleteClient(`/reference-data/lines/${row.id}`);
      if (lineId === row.id) resetLine();
    }, "Linha desativada e auditada.");
  }

  async function restoreLine(row: LineRow) {
    if (!window.confirm(`Restaurar a linha ${row.code}?`)) return;
    await run(async () => {
      if (DEMO_MODE) setData((current) => ({ ...current, lines: current.lines.map((item) => item.id === row.id ? { ...item, active: true, deletedAt: null } : item) }));
      else await apiPostClient(`/reference-data/lines/${row.id}/restore`, {});
    }, "Linha restaurada e auditada.");
  }

  function resetLossType() {
    setLossTypeId("");
    setLossTypeCode("PACKAGING");
    setLossTypeName("");
    setLossGoalKg("");
  }

  async function saveLossType() {
    if (!lossTypeName.trim()) {
      setMessage("Informe nome do tipo de perda.");
      return;
    }
    await run(async () => {
      const payload = { name: lossTypeName.trim(), defaultGoalKg: lossGoalKg ? Number(lossGoalKg) : null, active: true };
      if (DEMO_MODE) {
        setData((current) => ({
          ...current,
          lossTypes: lossTypeId
            ? current.lossTypes.map((row) => row.id === lossTypeId ? { ...row, ...payload } : row)
            : [...current.lossTypes, { id: crypto.randomUUID(), code: lossTypeCode, ...payload }]
        }));
      } else if (lossTypeId) {
        await apiPatchClient(`/reference-data/loss-types/${lossTypeId}`, payload);
      } else {
        await apiPostClient("/reference-data/loss-types", { code: lossTypeCode, ...payload });
      }
      resetLossType();
    }, lossTypeId ? "Tipo de perda atualizado e auditado." : "Tipo de perda criado e auditado.");
  }

  async function toggleLossType(row: LossTypeRow) {
    const action = row.active ? "desativar" : "reativar";
    if (!window.confirm(`${action[0]?.toUpperCase()}${action.slice(1)} ${row.name}?`)) return;
    await run(async () => {
      if (DEMO_MODE) setData((current) => ({ ...current, lossTypes: current.lossTypes.map((item) => item.id === row.id ? { ...item, active: !row.active } : item) }));
      else if (row.active) await apiDeleteClient(`/reference-data/loss-types/${row.id}`);
      else await apiPostClient(`/reference-data/loss-types/${row.id}/restore`, {});
    }, `Tipo de perda ${row.active ? "desativado" : "reativado"} e auditado.`);
  }

  function resetReason() {
    setReasonId("");
    setReasonName("");
  }

  async function saveReason() {
    if (!reasonName.trim()) {
      setMessage("Informe nome do motivo de parada.");
      return;
    }
    await run(async () => {
      const payload = { name: reasonName.trim(), active: true };
      if (DEMO_MODE) {
        setData((current) => ({
          ...current,
          downtimeReasons: reasonId
            ? current.downtimeReasons.map((row) => row.id === reasonId ? { ...row, ...payload } : row)
            : [...current.downtimeReasons, { id: crypto.randomUUID(), ...payload }]
        }));
      } else if (reasonId) {
        await apiPatchClient(`/reference-data/downtime-reasons/${reasonId}`, payload);
      } else {
        await apiPostClient("/reference-data/downtime-reasons", payload);
      }
      resetReason();
    }, reasonId ? "Motivo atualizado e auditado." : "Motivo criado e auditado.");
  }

  async function toggleReason(row: DowntimeReasonRow) {
    const action = row.active ? "desativar" : "reativar";
    if (!window.confirm(`${action[0]?.toUpperCase()}${action.slice(1)} ${row.name}?`)) return;
    await run(async () => {
      if (DEMO_MODE) setData((current) => ({ ...current, downtimeReasons: current.downtimeReasons.map((item) => item.id === row.id ? { ...item, active: !row.active } : item) }));
      else if (row.active) await apiDeleteClient(`/reference-data/downtime-reasons/${row.id}`);
      else await apiPostClient(`/reference-data/downtime-reasons/${row.id}/restore`, {});
    }, `Motivo ${row.active ? "desativado" : "reativado"} e auditado.`);
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Cadastros-base" description="Configure primeiro setores, linhas, tipos de perda e motivos de parada. Nenhum dado é criado automaticamente no banco operacional." />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-200">{message}</p>
            <p className="mt-1 text-xs text-slate-400">Alterações reais exigem ADMIN e geram auditoria antes/depois na mesma transação.</p>
          </div>
          <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4" />Atualizar</Button>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Setores" value={String(data.sectors.length)} />
        <StatCard label="Linhas ativas" value={String(data.lines.filter((row) => row.active).length)} />
        <StatCard label="Tipos de perda ativos" value={String(data.lossTypes.filter((row) => row.active).length)} />
        <StatCard label="Motivos ativos" value={String(data.downtimeReasons.filter((row) => row.active).length)} />
      </div>

      <Section title="Setores" description="Códigos P1/P2 são estruturais; nomes e descrições vêm da operação.">
        <div className="grid gap-3 md:grid-cols-4">
          <SelectField label="Código" value={sectorCode} onChange={(value) => setSectorCode(value as SectorCode)} disabled={Boolean(sectorId)} options={[{ value: "P1", label: "P1" }, { value: "P2", label: "P2" }]} />
          <TextField label="Nome" value={sectorName} onChange={setSectorName} />
          <TextField label="Descrição" value={sectorDescription} onChange={setSectorDescription} />
          <FormActions editing={Boolean(sectorId)} loading={loading} disabled={!canManage} onSave={() => void saveSector()} onCancel={resetSector} />
        </div>
        <DataTable title="Setores cadastrados" rows={data.sectors.length ? data.sectors.map((row) => ({
          Código: String(row.code),
          Nome: row.name,
          Descrição: row.description || "-",
          Vínculos: countTotal(row._count),
          Ações: canManage ? <ActionButtons onEdit={() => { setSectorId(row.id); setSectorCode(row.code); setSectorName(row.name); setSectorDescription(row.description ?? ""); }} onDelete={() => void removeSector(row)} /> : "Somente leitura"
        })) : [{ Código: "-", Nome: "Nenhum setor cadastrado.", Descrição: "-", Vínculos: "0", Ações: "-" }]} />
      </Section>

      <Section title="Linhas de produção" description="Cada linha pertence a um setor. Depois, equipamentos podem ser vinculados sem SQL manual.">
        <div className="grid gap-3 md:grid-cols-4">
          <SelectField label="Setor" value={lineSectorId} onChange={setLineSectorId} options={data.sectors.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))} />
          <TextField label="Código" value={lineCode} onChange={setLineCode} />
          <TextField label="Nome" value={lineName} onChange={setLineName} />
          <FormActions editing={Boolean(lineId)} loading={loading} disabled={!canManage} onSave={() => void saveLine()} onCancel={resetLine} />
        </div>
        <DataTable title="Linhas cadastradas" rows={data.lines.length ? data.lines.map((row) => ({
          Setor: String(row.sector.code),
          Código: String(row.code),
          Nome: row.name,
          Status: row.deletedAt ? "Removida" : row.active ? "Ativa" : "Inativa",
          Equipamentos: String(row._count?.equipment ?? 0),
          UUID: row.id,
          Ações: canManage ? row.deletedAt
            ? <Button type="button" variant="secondary" onClick={() => void restoreLine(row)}><RotateCcw className="size-4" />Restaurar</Button>
            : <ActionButtons onEdit={() => { setLineId(row.id); setLineSectorId(row.sectorId); setLineCode(row.code); setLineName(row.name); }} onDelete={() => void deactivateLine(row)} />
            : "Somente leitura"
        })) : [{ Setor: "-", Código: "-", Nome: "Nenhuma linha cadastrada.", Status: "-", Equipamentos: "0", UUID: "-", Ações: "-" }]} />
      </Section>

      <Section title="Tipos de perda" description="Cadastre somente categorias homologadas. Código é imutável depois da criação.">
        <div className="grid gap-3 md:grid-cols-4">
          <SelectField label="Código" value={lossTypeCode} onChange={(value) => setLossTypeCode(value as LossTypeCode)} disabled={Boolean(lossTypeId)} options={lossTypeCodes} />
          <TextField label="Nome" value={lossTypeName} onChange={setLossTypeName} />
          <TextField label="Meta padrão (kg, opcional)" type="number" value={lossGoalKg} onChange={setLossGoalKg} />
          <FormActions editing={Boolean(lossTypeId)} loading={loading} disabled={!canManage} onSave={() => void saveLossType()} onCancel={resetLossType} />
        </div>
        <DataTable title="Tipos de perda cadastrados" rows={data.lossTypes.length ? data.lossTypes.map((row) => ({
          Código: String(row.code),
          Nome: row.name,
          "Meta kg": row.defaultGoalKg ?? "-",
          Status: row.active ? "Ativo" : "Inativo",
          Lançamentos: String(row._count?.entries ?? 0),
          Ações: canManage ? <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => { setLossTypeId(row.id); setLossTypeCode(row.code); setLossTypeName(row.name); setLossGoalKg(row.defaultGoalKg == null ? "" : String(row.defaultGoalKg)); }}><Pencil className="size-4" />Editar</Button><Button type="button" variant={row.active ? "danger" : "secondary"} onClick={() => void toggleLossType(row)}>{row.active ? <Trash2 className="size-4" /> : <RotateCcw className="size-4" />}{row.active ? "Desativar" : "Reativar"}</Button></div> : "Somente leitura"
        })) : [{ Código: "-", Nome: "Nenhum tipo de perda cadastrado.", "Meta kg": "-", Status: "-", Lançamentos: "0", Ações: "-" }]} />
      </Section>

      <Section title="Motivos de parada" description="Motivos desativados preservam histórico e deixam de aparecer em novos lançamentos.">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <TextField label="Motivo" value={reasonName} onChange={setReasonName} />
          <FormActions editing={Boolean(reasonId)} loading={loading} disabled={!canManage} onSave={() => void saveReason()} onCancel={resetReason} />
        </div>
        <DataTable title="Motivos cadastrados" rows={data.downtimeReasons.length ? data.downtimeReasons.map((row) => ({
          Motivo: row.name,
          Status: row.active ? "Ativo" : "Inativo",
          Lançamentos: String(row._count?.entries ?? 0),
          Ações: canManage ? <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => { setReasonId(row.id); setReasonName(row.name); }}><Pencil className="size-4" />Editar</Button><Button type="button" variant={row.active ? "danger" : "secondary"} onClick={() => void toggleReason(row)}>{row.active ? <Trash2 className="size-4" /> : <RotateCcw className="size-4" />}{row.active ? "Desativar" : "Reativar"}</Button></div> : "Somente leitura"
        })) : [{ Motivo: "Nenhum motivo de parada cadastrado.", Status: "-", Lançamentos: "0", Ações: "-" }]} />
      </Section>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <Card className="space-y-4"><div><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-slate-400">{description}</p></div>{children}</Card>;
}

function TextField({ label, value, onChange, type = "text" }: { label: string; value: string; onChange: (value: string) => void; type?: string }) {
  return <label className="space-y-2"><span className="text-xs uppercase text-slate-400">{label}</span><input type={type} min={type === "number" ? "0" : undefined} step={type === "number" ? "0.001" : undefined} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function SelectField({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; disabled?: boolean }) {
  return <label className="space-y-2"><span className="text-xs uppercase text-slate-400">{label}</span><select className="w-full rounded-md border border-[var(--line)] bg-[#0b1422] px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}><option value="">Selecione</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function FormActions({ editing, loading, disabled, onSave, onCancel }: { editing: boolean; loading: boolean; disabled: boolean; onSave: () => void; onCancel: () => void }) {
  return <div className="flex items-end gap-2"><Button type="button" onClick={onSave} disabled={loading || disabled}><Save className="size-4" />{editing ? "Salvar" : "Criar"}</Button>{editing ? <Button type="button" variant="secondary" onClick={onCancel} disabled={loading}><X className="size-4" />Cancelar</Button> : null}</div>;
}

function ActionButtons({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={onEdit}><Pencil className="size-4" />Editar</Button><Button type="button" variant="danger" onClick={onDelete}><Trash2 className="size-4" />Remover</Button></div>;
}

function countTotal(counts?: CountMap) {
  return String(Object.values(counts ?? {}).reduce((sum, value) => sum + value, 0));
}
