"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, RefreshCw, Save, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { canDeactivateReference, canManageShifts } from "@/lib/admin-reference-permissions";
import { createDemoShiftRows } from "@/lib/demo/admin-reference-preview";
import { apiDeleteClient, apiGetClient, apiPatchClient, apiPostClient, DEMO_MODE, getSession } from "@/services/api";

interface ShiftRow {
  id: string;
  code: string;
  name: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

interface ShiftForm {
  code: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

const emptyForm: ShiftForm = { code: "", name: "", startsAt: "08:00", endsAt: "17:00" };

export default function ShiftsPage() {
  const session = useMemo(() => getSession(), []);
  const roles = session?.user.roles ?? [];
  const canManage = canManageShifts(roles);
  const canDeactivate = canDeactivateReference(roles);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [form, setForm] = useState<ShiftForm>(emptyForm);
  const [editingId, setEditingId] = useState("");
  const [message, setMessage] = useState("Carregando turnos da API.");
  const [loading, setLoading] = useState(false);

  async function loadShifts() {
    if (DEMO_MODE) {
      setShifts(createDemoShiftRows());
      setMessage("Preview isolado: turnos demonstrativos carregados localmente.");
      return;
    }
    if (!session) {
      setShifts([]);
      setMessage("Entre no sistema para consultar os turnos.");
      return;
    }
    setLoading(true);
    try {
      const rows = await apiGetClient<ShiftRow[]>("/shifts");
      setShifts(rows);
      setMessage(`${rows.length} turno(s) carregado(s) da API.`);
    } catch (error) {
      setShifts([]);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar os turnos.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadShifts();
  }, []);

  function resetForm() {
    setEditingId("");
    setForm(emptyForm);
  }

  function edit(row: ShiftRow) {
    setEditingId(row.id);
    setForm({ code: row.code, name: row.name, startsAt: row.startsAt, endsAt: row.endsAt });
    setMessage(`Editando ${row.code}.`);
  }

  async function save() {
    if (!canManage) {
      setMessage("Seu perfil possui acesso somente para consulta de turnos.");
      return;
    }
    if (!form.code.trim() || form.name.trim().length < 2 || !form.startsAt || !form.endsAt) {
      setMessage("Informe código, nome, horário inicial e horário final.");
      return;
    }
    const payload = { code: form.code.trim().toUpperCase(), name: form.name.trim(), startsAt: form.startsAt, endsAt: form.endsAt, active: true };
    setLoading(true);
    try {
      if (DEMO_MODE) {
        setShifts((current) => editingId
          ? current.map((row) => row.id === editingId ? { ...row, ...payload } : row)
          : [...current, { id: crypto.randomUUID(), ...payload }]);
        setMessage(editingId ? "Turno demonstrativo atualizado localmente." : "Turno demonstrativo criado localmente.");
        resetForm();
        return;
      }
      if (editingId) {
        await apiPatchClient(`/shifts/${editingId}`, payload);
      } else {
        await apiPostClient("/shifts", payload);
      }
      const action = editingId ? "atualizado" : "criado";
      resetForm();
      await loadShifts();
      setMessage(`Turno ${action} e auditado pela API.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar o turno.");
    } finally {
      setLoading(false);
    }
  }

  async function deactivate(row: ShiftRow) {
    if (!canDeactivate) {
      setMessage("Somente administradores podem desativar turnos.");
      return;
    }
    if (!window.confirm(`Desativar o turno ${row.code}?`)) return;
    setLoading(true);
    try {
      if (DEMO_MODE) {
        setShifts((current) => current.filter((item) => item.id !== row.id));
        if (editingId === row.id) resetForm();
        setMessage("Turno demonstrativo desativado localmente.");
        return;
      }
      await apiDeleteClient(`/shifts/${row.id}`);
      if (editingId === row.id) resetForm();
      await loadShifts();
      setMessage("Turno desativado e auditado pela API.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível desativar o turno.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Turnos" description="Cadastro administrativo dos horários operacionais e equipes de trabalho." />

      {canManage ? <Card className="space-y-4">
        <h3 className="font-semibold">{editingId ? "Editar turno" : "Novo turno"}</h3>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <TextField label="Código" value={form.code} onChange={(value) => setForm((current) => ({ ...current, code: value }))} placeholder="Ex.: T1" />
          <TextField label="Nome" value={form.name} onChange={(value) => setForm((current) => ({ ...current, name: value }))} placeholder="Nome do turno" />
          <TextField label="Início" type="time" value={form.startsAt} onChange={(value) => setForm((current) => ({ ...current, startsAt: value }))} />
          <TextField label="Fim" type="time" value={form.endsAt} onChange={(value) => setForm((current) => ({ ...current, endsAt: value }))} />
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="button" onClick={() => void save()} disabled={loading}><Save className="size-4" />{editingId ? "Salvar alterações" : "Criar turno"}</Button>
          {editingId ? <Button type="button" variant="secondary" onClick={resetForm} disabled={loading}><X className="size-4" />Cancelar</Button> : null}
        </div>
      </Card> : <Card><p className="text-sm text-slate-300">Consulta permitida. Seu perfil não pode criar ou editar turnos.</p></Card>}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-300">{message}</p>
          <Button type="button" variant="secondary" onClick={() => void loadShifts()} disabled={loading}><RefreshCw className="size-4" />{loading ? "Carregando..." : "Atualizar"}</Button>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Turnos listados" value={String(shifts.length)} />
        <StatCard label="Cobertura horária" value={shifts.length ? `${shifts[0]?.startsAt ?? "-"} — ${shifts.at(-1)?.endsAt ?? "-"}` : "Sem turnos"} />
        <StatCard label="Modo" value={DEMO_MODE ? "Preview isolado" : "API operacional"} />
      </div>

      <DataTable title="Turnos cadastrados" rows={shifts.length ? shifts.map((row) => ({
        Código: row.code,
        Turno: row.name,
        Início: row.startsAt,
        Fim: row.endsAt,
        Status: row.active ? "Ativo" : "Inativo",
        Ações: canManage || canDeactivate ? <div className="flex flex-wrap gap-2">
          {canManage ? <Button type="button" variant="secondary" onClick={() => edit(row)} disabled={loading}><Pencil className="size-4" />Editar</Button> : null}
          {canDeactivate ? <Button type="button" variant="danger" onClick={() => void deactivate(row)} disabled={loading}><Trash2 className="size-4" />Desativar</Button> : null}
        </div> : "Somente leitura"
      })) : [{ Código: "-", Turno: "Nenhum turno encontrado.", Início: "-", Fim: "-", Status: "-", Ações: "-" }]} />
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return <label className="space-y-2"><span className="text-xs uppercase text-slate-400">{label}</span><input type={type} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
