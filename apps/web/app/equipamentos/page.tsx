"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, RefreshCw, Save, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { canDeactivateReference, canManageEquipment, isUuid } from "@/lib/admin-reference-permissions";
import { createDemoEquipmentRows } from "@/lib/demo/admin-reference-preview";
import { apiDeleteClient, apiGetClient, apiPatchClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

interface ProductionLineRow {
  id: string;
  code: string;
  name: string;
  active?: boolean;
  sector?: { code: string; name?: string };
}

interface EquipmentRow {
  id: string;
  productionLineId: string;
  code: string;
  name: string;
  type?: string | null;
  active: boolean;
  productionLine?: ProductionLineRow;
}

interface EquipmentForm {
  productionLineId: string;
  code: string;
  name: string;
  type: string;
}

const emptyForm: EquipmentForm = { productionLineId: "", code: "", name: "", type: "" };

export default function EquipmentPage() {
  const session = useMemo(() => getSession(), []);
  const roles = session?.user.roles ?? [];
  const canManage = canManageEquipment(roles);
  const canDeactivate = canDeactivateReference(roles);
  const [equipment, setEquipment] = useState<EquipmentRow[]>([]);
  const [productionLines, setProductionLines] = useState<ProductionLineRow[]>([]);
  const [form, setForm] = useState<EquipmentForm>(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("Carregando equipamentos da API.");
  const [loading, setLoading] = useState(false);

  const knownLines = useMemo(() => {
    const lines = [
      ...productionLines,
      ...equipment.flatMap((row) => row.productionLine ? [row.productionLine] : [])
    ];
    return Array.from(new Map(lines.map((line) => [line.id, line])).values());
  }, [equipment, productionLines]);

  const visibleEquipment = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("pt-BR");
    if (!term) return equipment;
    return equipment.filter((row) => [row.code, row.name, row.type, row.productionLine?.code, row.productionLine?.name]
      .some((value) => value?.toLocaleLowerCase("pt-BR").includes(term)));
  }, [equipment, search]);

  async function loadEquipment() {
    if (DEMO_MODE) {
      const rows = createDemoEquipmentRows();
      setEquipment(rows);
      setProductionLines(Array.from(new Map(rows.map((row) => [row.productionLine.id, row.productionLine])).values()));
      setMessage("Preview isolado: equipamentos demonstrativos carregados localmente.");
      return;
    }
    if (!session) {
      setEquipment([]);
      setProductionLines([]);
      setMessage("Entre no sistema para consultar os equipamentos.");
      return;
    }
    setLoading(true);
    try {
      const [rows, lines] = await Promise.all([
        apiGetClient<EquipmentRow[]>("/equipment"),
        apiGetClient<ProductionLineRow[]>("/reference-data/lines?active=true")
      ]);
      setEquipment(rows);
      setProductionLines(lines);
      setMessage(`${rows.length} equipamento(s) e ${lines.length} linha(s) ativa(s) carregados da API.`);
    } catch (error) {
      setEquipment([]);
      setProductionLines([]);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar os equipamentos.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadEquipment();
  }, []);

  function resetForm() {
    setEditingId("");
    setForm(emptyForm);
  }

  function edit(row: EquipmentRow) {
    setEditingId(row.id);
    setForm({ productionLineId: row.productionLineId, code: row.code, name: row.name, type: row.type ?? "" });
    setMessage(`Editando ${row.code}.`);
  }

  async function save() {
    if (!canManage) {
      setMessage("Seu perfil possui acesso somente para consulta de equipamentos.");
      return;
    }
    if (!isUuid(form.productionLineId)) {
      setMessage("Selecione uma linha de produção ativa já cadastrada.");
      return;
    }
    if (!form.code.trim() || form.name.trim().length < 2) {
      setMessage("Informe código e nome do equipamento.");
      return;
    }

    const payload = {
      productionLineId: form.productionLineId,
      code: form.code.trim().toUpperCase(),
      name: form.name.trim(),
      type: form.type.trim() || undefined,
      active: true
    };
    setLoading(true);
    try {
      if (DEMO_MODE) {
        const line = knownLines.find((item) => item.id === payload.productionLineId);
        if (!line) throw new Error("No preview, selecione uma das linhas demonstrativas sugeridas.");
        setEquipment((current) => editingId
          ? current.map((row) => row.id === editingId ? { ...row, ...payload, productionLine: line } : row)
          : [...current, { id: crypto.randomUUID(), ...payload, productionLine: line }]);
        setMessage(editingId ? "Equipamento demonstrativo atualizado localmente." : "Equipamento demonstrativo criado localmente.");
        resetForm();
        return;
      }
      if (editingId) {
        await apiPatchClient(`/equipment/${editingId}`, payload);
      } else {
        await apiPostClient("/equipment", payload);
      }
      const action = editingId ? "atualizado" : "criado";
      resetForm();
      await loadEquipment();
      setMessage(`Equipamento ${action} e auditado pela API.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar o equipamento.");
    } finally {
      setLoading(false);
    }
  }

  async function deactivate(row: EquipmentRow) {
    if (!canDeactivate) {
      setMessage("Somente administradores podem desativar equipamentos.");
      return;
    }
    if (!window.confirm(`Desativar o equipamento ${row.code}?`)) return;
    setLoading(true);
    try {
      if (DEMO_MODE) {
        setEquipment((current) => current.filter((item) => item.id !== row.id));
        if (editingId === row.id) resetForm();
        setMessage("Equipamento demonstrativo desativado localmente.");
        return;
      }
      await apiDeleteClient(`/equipment/${row.id}`);
      if (editingId === row.id) resetForm();
      await loadEquipment();
      setMessage("Equipamento desativado e auditado pela API.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível desativar o equipamento.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Equipamentos" description="Cadastro administrativo de máquinas e ativos vinculados às linhas de produção." />

      {canManage ? (
        <Card className="space-y-4">
          <div>
            <h3 className="font-semibold">{editingId ? "Editar equipamento" : "Novo equipamento"}</h3>
            <p className="mt-1 text-sm text-slate-400">
              Selecione uma linha ativa do catálogo operacional. Cadastre setores e linhas primeiro em Cadastros-base.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <LineSelect lines={knownLines} value={form.productionLineId} onChange={(value) => setForm((current) => ({ ...current, productionLineId: value }))} />
            <TextField label="Código" value={form.code} onChange={(value) => setForm((current) => ({ ...current, code: value }))} placeholder="Ex.: EMB-P1" />
            <TextField label="Nome" value={form.name} onChange={(value) => setForm((current) => ({ ...current, name: value }))} placeholder="Nome do equipamento" />
            <TextField label="Tipo" value={form.type} onChange={(value) => setForm((current) => ({ ...current, type: value }))} placeholder="Embaladora, dosador..." />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="button" onClick={() => void save()} disabled={loading}>
              <Save className="size-4" />
              {editingId ? "Salvar alterações" : "Criar equipamento"}
            </Button>
            {editingId ? <Button type="button" variant="secondary" onClick={resetForm} disabled={loading}><X className="size-4" />Cancelar</Button> : null}
          </div>
        </Card>
      ) : <Card><p className="text-sm text-slate-300">Consulta permitida. Seu perfil não pode criar ou editar equipamentos.</p></Card>}

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <input className="min-w-72 flex-1 rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar código, nome, tipo ou linha" />
          <Button type="button" variant="secondary" onClick={() => void loadEquipment()} disabled={loading}><RefreshCw className="size-4" />{loading ? "Carregando..." : "Atualizar"}</Button>
        </div>
        <p className="mt-4 text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Equipamentos listados" value={String(equipment.length)} />
        <StatCard label="Linhas identificadas" value={String(knownLines.length)} />
        <StatCard label="Modo" value={DEMO_MODE ? "Preview isolado" : "API operacional"} />
      </div>

      <DataTable title="Equipamentos cadastrados" rows={visibleEquipment.length ? visibleEquipment.map((row) => ({
        Código: row.code,
        Equipamento: row.name,
        Tipo: row.type || "-",
        Setor: row.productionLine?.sector?.code ?? "-",
        Linha: row.productionLine ? `${row.productionLine.code} — ${row.productionLine.name}` : "UUID não detalhado pela API",
        "UUID da linha": row.productionLineId,
        Status: row.active ? "Ativo" : "Inativo",
        Ações: canManage || canDeactivate ? <div className="flex flex-wrap gap-2">
          {canManage ? <Button type="button" variant="secondary" onClick={() => edit(row)} disabled={loading}><Pencil className="size-4" />Editar</Button> : null}
          {canDeactivate ? <Button type="button" variant="danger" onClick={() => void deactivate(row)} disabled={loading}><Trash2 className="size-4" />Desativar</Button> : null}
        </div> : "Somente leitura"
      })) : [{ Código: "-", Equipamento: "Nenhum equipamento encontrado.", Tipo: "-", Setor: "-", Linha: "-", "UUID da linha": "-", Status: "-", Ações: "-" }]} />
    </div>
  );
}

function LineSelect({ lines, value, onChange }: { lines: ProductionLineRow[]; value: string; onChange: (value: string) => void }) {
  return <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Linha de produção</span><select className="w-full rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)}><option value="">{lines.length ? "Selecione a linha" : "Cadastre uma linha primeiro"}</option>{lines.map((line) => <option key={line.id} value={line.id}>{line.sector?.code ?? "-"} · {line.code} · {line.name}</option>)}</select></label>;
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="space-y-2"><span className="text-xs uppercase text-slate-400">{label}</span><input className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
