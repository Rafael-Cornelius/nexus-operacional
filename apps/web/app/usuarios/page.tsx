"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiGetClient, apiPostClient, getSession } from "@/services/api";

type RoleCode = "ADMIN" | "MANAGER" | "SUPERVISOR" | "OPERATOR" | "VIEWER";

interface UserRow {
  id: string;
  email: string;
  name: string;
  active: boolean;
  lastLoginAt?: string | null;
  roles: Array<{ role: { code: RoleCode; name?: string } }>;
}

const roleOptions: Array<{ value: RoleCode; label: string }> = [
  { value: "ADMIN", label: "Admin" },
  { value: "MANAGER", label: "Gestor" },
  { value: "SUPERVISOR", label: "Supervisor" },
  { value: "OPERATOR", label: "Operador" },
  { value: "VIEWER", label: "Visualizador" }
];

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<RoleCode[]>(["VIEWER"]);
  const [message, setMessage] = useState("Aguardando login de administrador para carregar usuarios reais.");
  const [loading, setLoading] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadUsers() {
    if (!session) return;
    setLoading(true);
    try {
      const data = await apiGetClient<UserRow[]>("/users");
      setUsers(data);
      setMessage(data.length ? `${data.length} usuario(s) carregado(s) da API.` : "Nenhum usuario retornado pela API.");
    } catch (error) {
      setUsers([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar usuarios da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function createUser() {
    if (!session) {
      setMessage("Entre como administrador para criar usuarios.");
      return;
    }
    if (!roles.length) {
      setMessage("Selecione pelo menos um perfil.");
      return;
    }
    setLoading(true);
    try {
      await apiPostClient("/users", { name, email, password, roles });
      await loadUsers();
      setMessage("Usuario criado com perfis RBAC.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha ao criar usuario.");
    } finally {
      setLoading(false);
    }
  }

  function toggleRole(role: RoleCode) {
    setRoles((current) => current.includes(role) ? current.filter((item) => item !== role) : [...current, role]);
  }

  const activeUsers = users.filter((user) => user.active).length;
  const uniqueRoles = new Set(users.flatMap((user) => user.roles.map((item) => item.role.code))).size;

  return (
    <div className="space-y-6">
      <PageHeader title="Usuarios e permissoes" description="RBAC para administrador, gestor, supervisor, operador e visualizador." />

      <Card>
        <div className="grid gap-4 md:grid-cols-3">
          <Input label="Nome" value={name} onChange={setName} />
          <Input label="Email" type="email" value={email} onChange={setEmail} />
          <Input label="Senha inicial" type="password" value={password} onChange={setPassword} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {roleOptions.map((option) => (
            <label key={option.value} className="inline-flex items-center gap-2 rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm text-slate-200">
              <input type="checkbox" checked={roles.includes(option.value)} onChange={() => toggleRole(option.value)} />
              {option.label}
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button type="button" onClick={createUser} disabled={loading}>
            <Save className="size-4" />
            Criar usuario
          </Button>
          <Button type="button" className="border-slate-400/30 bg-white/5" onClick={loadUsers} disabled={loading}>
            <RefreshCw className="size-4" />
            Atualizar
          </Button>
        </div>
        <p className="mt-4 text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Usuarios ativos" value={String(activeUsers)} status="OK" />
        <StatCard label="Perfis em uso" value={String(uniqueRoles)} />
        <StatCard label="Usuarios inativos" value={String(users.length - activeUsers)} status={users.length - activeUsers > 0 ? "ATTENTION" : "OK"} />
      </div>

      <DataTable
        title="Usuarios"
        rows={users.map((user) => ({
          Usuario: user.name,
          Email: user.email,
          Perfis: user.roles.map((item) => item.role.code).join(", "),
          Status: user.active ? "Ativo" : "Inativo",
          UltimoLogin: user.lastLoginAt ? user.lastLoginAt.slice(0, 19).replace("T", " ") : "-"
        }))}
      />
    </div>
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
