"use client";

import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, Ban, CheckCircle2, Power, RefreshCw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiDeleteClient, apiGetClient, apiPatchClient, apiPostClient, getSession } from "@/services/api";
import { formatKg } from "@/lib/format";

interface ProductRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
  deletedAt?: string | null;
  pricePerKg?: string | number;
  filmCostPerKg?: string | number;
  effectivePricePeriod?: ProductPricePeriod | null;
  packageFilmWeightG?: string | number;
  defaultSector?: { code: "P1" | "P2" };
  weightConfig?: {
    boxWeightKg: string | number;
    packagesPerBox: number;
    massWeightKg: string | number;
    targetPackageWeightG: string | number;
  } | null;
}

interface ProductPricePeriod {
  id: string;
  productId: string;
  startsOn: string;
  endsOn?: string | null;
  pricePerKg: string | number;
  filmCostPerKg: string | number;
  currency?: string | null;
  origin?: string | null;
  observation?: string | null;
  responsibleBy?: string | null;
  approvedBy?: string | null;
  responsible?: { id: string; name: string; email: string } | null;
  approver?: { id: string; name: string; email: string } | null;
  retirer?: { id: string; name: string; email: string } | null;
  approvalReason?: string | null;
  status: "DRAFT" | "APPROVED" | "RETIRED";
  version: number;
  recordVersion: number;
}

function formatMonetary(value: string | number, currency?: string | null) {
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return `${currency ?? "-"} ${Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 4 })}`;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 4 }).format(Number(value));
}

export default function ProductsPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("Carregando catalogo de produtos da API.");
  const [loading, setLoading] = useState(false);
  const [priceProductId, setPriceProductId] = useState("");
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10));
  const [endsOn, setEndsOn] = useState("");
  const [pricePerKg, setPricePerKg] = useState(0);
  const [filmCostPerKg, setFilmCostPerKg] = useState(0);
  const [currency, setCurrency] = useState("");
  const [origin, setOrigin] = useState("");
  const [observation, setObservation] = useState("");
  const [pricePeriods, setPricePeriods] = useState<ProductPricePeriod[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const session = useMemo(() => getSession(), []);

  async function loadProducts(nextSearch = search) {
    if (!session) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nextSearch) params.set("search", nextSearch);
      if (showDeleted) params.set("deleted", "true");
      const query = params.size ? `?${params.toString()}` : "";
      const data = await apiGetClient<ProductRow[]>(`/products${query}`);
      setProducts(data);
      setMessage(`${data.length} produto(s) carregado(s) da API.`);
    } catch (error) {
      setProducts([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar produtos da API.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadProducts("");
  }, []);

  useEffect(() => {
    if (!priceProductId || !session) {
      setPricePeriods([]);
      return;
    }
    loadPricePeriods(priceProductId);
  }, [priceProductId]);

  async function loadPricePeriods(productId: string) {
    try {
      const rows = await apiGetClient<ProductPricePeriod[]>(`/products/${productId}/prices`);
      setPricePeriods(rows);
    } catch (error) {
      setPricePeriods([]);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar o historico de precos.");
    }
  }

  async function deactivate(id: string) {
    if (!session) {
      setMessage("Entre no sistema para inativar produtos.");
      return;
    }
    await apiPatchClient(`/products/${id}/deactivate`, {});
    await loadProducts();
  }

  async function activate(id: string) {
    if (!session) return;
    await apiPatchClient(`/products/${id}/activate`, {});
    await loadProducts();
  }

  async function remove(id: string) {
    if (!session?.user.roles.includes("ADMIN")) {
      setMessage("Somente administrador pode excluir logicamente um produto.");
      return;
    }
    if (!window.confirm("Excluir logicamente este produto? O histórico será preservado e poderá ser restaurado.")) return;
    await apiDeleteClient(`/products/${id}`);
    await loadProducts();
  }

  async function restore(id: string) {
    if (!session?.user.roles.includes("ADMIN")) return;
    await apiPostClient(`/products/${id}/restore`, {});
    await loadProducts();
  }

  async function savePricePeriod() {
    if (!session || !priceProductId) {
      setMessage("Selecione um produto para registrar o período de preço.");
      return;
    }
    setLoading(true);
    try {
      await apiPostClient(`/products/${priceProductId}/prices`, {
        startsOn,
        endsOn: endsOn || null,
        pricePerKg,
        filmCostPerKg,
        currency,
        origin,
        observation: observation || null
      });
      setMessage("Rascunho criado. Preco ainda nao entra em calculos ate aprovacao independente.");
      setObservation("");
      await loadPricePeriods(priceProductId);
      await loadProducts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível registrar o preço.");
    } finally {
      setLoading(false);
    }
  }

  async function approvePrice(period: ProductPricePeriod) {
    if (!priceProductId || !session || !session.user.roles.some((role) => ["ADMIN", "MANAGER"].includes(role))) return;
    const reason = window.prompt("Motivo da aprovacao (minimo 5 caracteres):");
    if (!reason) return;
    setLoading(true);
    try {
      await apiPostClient(`/products/${priceProductId}/prices/${period.id}/approve`, {
        recordVersion: period.recordVersion,
        reason
      });
      setMessage(`Preco v${period.version} aprovado. Novos calculos na vigencia usarao este registro.`);
      await Promise.all([loadPricePeriods(priceProductId), loadProducts()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Nao foi possivel aprovar o preco.");
    } finally {
      setLoading(false);
    }
  }

  async function retirePrice(period: ProductPricePeriod) {
    if (!priceProductId || !session || !session.user.roles.some((role) => ["ADMIN", "MANAGER"].includes(role))) return;
    const reason = window.prompt("Motivo da aposentadoria (minimo 5 caracteres):");
    if (!reason) return;
    setLoading(true);
    try {
      await apiPostClient(`/products/${priceProductId}/prices/${period.id}/retire`, {
        recordVersion: period.recordVersion,
        reason
      });
      setMessage(`Preco v${period.version} aposentado. Lancamentos existentes preservam valor e origem gravados.`);
      await Promise.all([loadPricePeriods(priceProductId), loadProducts()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Nao foi possivel aposentar o preco.");
    } finally {
      setLoading(false);
    }
  }

  const activeCount = products.filter((product) => product.active).length;

  return (
    <div className="space-y-6">
      <PageHeader title="Banco de produtos" description="Cadastro unico de produto, pesos tecnicos, pacotes por caixa e tolerancia de sobrepeso." />

      <div className="flex flex-wrap gap-3">
        <input className="min-w-72 rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-300/60" placeholder="Buscar codigo ou produto" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Button type="button" onClick={() => loadProducts()} disabled={loading}>
          <RefreshCw className="size-4" />
          {loading ? "Carregando..." : "Buscar"}
        </Button>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={showDeleted} onChange={(event) => setShowDeleted(event.target.checked)} />
          Mostrar removidos
        </label>
      </div>

      <Card className="space-y-3">
        <h2 className="font-semibold">Governança de preços por período</h2>
        <p className="text-sm text-slate-400">Crie rascunho imutável. Outro administrador ou gerente aprova. Só preço aprovado e vigente entra em novos cálculos.</p>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Produto</span><select className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm" value={priceProductId} onChange={(event) => setPriceProductId(event.target.value)}><option value="">Selecione</option>{products.filter((product) => product.active).map((product) => <option key={product.id} value={product.id}>{product.code} - {product.name}</option>)}</select></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Início</span><input type="date" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Fim opcional</span><input type="date" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Moeda</span><input maxLength={3} placeholder="BRL" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm uppercase" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Preço/kg</span><input type="number" min="0.0001" step="0.0001" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={pricePerKg} onChange={(event) => setPricePerKg(Number(event.target.value))} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Filme/kg</span><input type="number" min="0" step="0.0001" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={filmCostPerKg} onChange={(event) => setFilmCostPerKg(Number(event.target.value))} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Origem</span><input maxLength={120} placeholder="Informe fonte do valor" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={origin} onChange={(event) => setOrigin(event.target.value)} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Observação</span><input maxLength={2000} className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={observation} onChange={(event) => setObservation(event.target.value)} /></label>
        </div>
        <Button type="button" onClick={savePricePeriod} disabled={loading}>Criar rascunho</Button>
      </Card>

      {priceProductId ? (
        <DataTable
          title="Histórico imutável de preços"
          rows={pricePeriods.map((period) => ({
            Versao: `v${period.version}`,
            Status: period.status,
            Vigencia: `${new Date(period.startsOn).toLocaleDateString("pt-BR", { timeZone: "UTC" })} a ${period.endsOn ? new Date(period.endsOn).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "aberta"}`,
            Preco: `${period.currency ?? "-"} ${Number(period.pricePerKg).toLocaleString("pt-BR", { minimumFractionDigits: 4 })}/kg`,
            Filme: `${period.currency ?? "-"} ${Number(period.filmCostPerKg).toLocaleString("pt-BR", { minimumFractionDigits: 4 })}/kg`,
            Origem: period.origin ?? "Nao informada (legado)",
            Responsavel: period.responsible ? `${period.responsible.name} (${period.responsible.email})` : "Nao identificado (legado)",
            Aprovador: period.approver ? `${period.approver.name} (${period.approver.email})` : "-",
            Acao: session?.user.roles.some((role) => ["ADMIN", "MANAGER"].includes(role)) && period.status !== "RETIRED" ? (
              <div className="flex flex-wrap gap-2">
                {period.status === "DRAFT" && period.responsibleBy !== session.user.id ? <Button type="button" onClick={() => approvePrice(period)} disabled={loading}><CheckCircle2 className="size-4" />Aprovar</Button> : null}
                {period.status === "DRAFT" && period.responsibleBy === session.user.id ? <span className="self-center text-xs text-amber-200">Outro gestor deve aprovar</span> : null}
                <Button type="button" variant="danger" onClick={() => retirePrice(period)} disabled={loading}><Ban className="size-4" />Aposentar</Button>
              </div>
            ) : "-"
          }))}
        />
      ) : null}

      <Card>
        <p className="text-sm text-slate-300">{message}</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Produtos listados" value={String(products.length)} status="OK" />
        <StatCard label="Ativos" value={String(activeCount)} status="OK" />
        <StatCard label="Inativos" value={String(products.length - activeCount)} status={products.length - activeCount > 0 ? "ATTENTION" : "OK"} />
      </div>

      <DataTable
        title="Produtos"
        rows={products.map((product) => ({
          Codigo: product.code,
          Produto: product.name,
          Setor: product.defaultSector?.code ?? "-",
          Caixa: product.weightConfig ? formatKg(Number(product.weightConfig.boxWeightKg)) : "-",
          Pacotes: product.weightConfig?.packagesPerBox ?? "-",
          Alvo: product.weightConfig ? `${Number(product.weightConfig.targetPackageWeightG).toLocaleString("pt-BR")} g` : "-",
          "Preço aprovado/kg": product.effectivePricePeriod ? formatMonetary(product.effectivePricePeriod.pricePerKg, product.effectivePricePeriod.currency) : "Sem preço aprovado vigente",
          "Filme aprovado/kg": product.effectivePricePeriod ? formatMonetary(product.effectivePricePeriod.filmCostPerKg, product.effectivePricePeriod.currency) : "-",
          "Filme/pacote": `${Number(product.packageFilmWeightG ?? 0).toLocaleString("pt-BR")} g`,
          Status: product.deletedAt ? "Removido" : product.active ? "Ativo" : "Inativo",
          Acao: (
            <div className="flex flex-wrap gap-2">
              {product.deletedAt ? (
                <Button type="button" className="border-cyan-300/30 bg-cyan-300/10 text-cyan-100" onClick={() => restore(product.id)}>
                  <ArchiveRestore className="size-4" />
                  Restaurar
                </Button>
              ) : product.active ? (
                <Button type="button" className="border-amber-300/30 bg-amber-300/10 text-amber-100" onClick={() => deactivate(product.id)}>
                  <Power className="size-4" />
                  Inativar
                </Button>
              ) : (
                <>
                  <Button type="button" className="border-emerald-300/30 bg-emerald-300/10 text-emerald-100" onClick={() => activate(product.id)}>
                    <Power className="size-4" />
                    Ativar
                  </Button>
                  {session?.user.roles.includes("ADMIN") ? (
                    <Button type="button" className="border-rose-300/30 bg-rose-300/10 text-rose-100" onClick={() => remove(product.id)}>
                      <Trash2 className="size-4" />
                      Excluir
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          )
        }))}
      />
    </div>
  );
}
