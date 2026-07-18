"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/tables/data-table";
import { Button } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { apiDeleteClient, apiGetClient, apiPostClient, getSession } from "@/services/api";
import { formatCurrency, formatKg } from "@/lib/format";

interface ProductRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
  pricePerKg?: string | number;
  filmCostPerKg?: string | number;
  packageFilmWeightG?: string | number;
  defaultSector?: { code: "P1" | "P2" };
  weightConfig?: {
    boxWeightKg: string | number;
    packagesPerBox: number;
    massWeightKg: string | number;
    targetPackageWeightG: string | number;
  } | null;
}

export default function ProductsPage() {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("Carregando catalogo de produtos da API.");
  const [loading, setLoading] = useState(false);
  const [priceProductId, setPriceProductId] = useState("");
  const [startsOn, setStartsOn] = useState(new Date().toISOString().slice(0, 10));
  const [pricePerKg, setPricePerKg] = useState(0);
  const [filmCostPerKg, setFilmCostPerKg] = useState(0);
  const session = useMemo(() => getSession(), []);

  async function loadProducts(nextSearch = search) {
    if (!session) return;
    setLoading(true);
    try {
      const query = nextSearch ? `?search=${encodeURIComponent(nextSearch)}` : "";
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

  async function deactivate(id: string) {
    if (!session) {
      setMessage("Entre no sistema para inativar produtos.");
      return;
    }
    await apiDeleteClient(`/products/${id}`);
    await loadProducts();
  }

  async function savePricePeriod() {
    if (!session || !priceProductId) {
      setMessage("Selecione um produto para registrar o período de preço.");
      return;
    }
    setLoading(true);
    try {
      await apiPostClient(`/products/${priceProductId}/prices`, { startsOn, pricePerKg, filmCostPerKg });
      setMessage("Preço por período registrado. Novos lançamentos conservarão este valor histórico.");
      await loadProducts();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível registrar o preço.");
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
      </div>

      <Card className="space-y-3">
        <h2 className="font-semibold">Preço e custo de filme por período</h2>
        <p className="text-sm text-slate-400">O valor é gravado junto aos novos lançamentos, preservando o histórico quando o preço muda.</p>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Produto</span><select className="w-full rounded-md border border-[var(--line)] bg-[#07101d] px-3 py-2 text-sm" value={priceProductId} onChange={(event) => setPriceProductId(event.target.value)}><option value="">Selecione</option>{products.filter((product) => product.active).map((product) => <option key={product.id} value={product.id}>{product.code} - {product.name}</option>)}</select></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Início</span><input type="date" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Preço R$/kg</span><input type="number" min="0" step="0.01" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={pricePerKg} onChange={(event) => setPricePerKg(Number(event.target.value))} /></label>
          <label className="space-y-2"><span className="text-xs uppercase text-slate-400">Filme R$/kg</span><input type="number" min="0" step="0.01" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm" value={filmCostPerKg} onChange={(event) => setFilmCostPerKg(Number(event.target.value))} /></label>
        </div>
        <Button type="button" onClick={savePricePeriod} disabled={loading}>Registrar período</Button>
      </Card>

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
          "Preço/kg": formatCurrency(Number(product.pricePerKg ?? 0)),
          "Filme/kg": formatCurrency(Number(product.filmCostPerKg ?? 0)),
          "Filme/pacote": `${Number(product.packageFilmWeightG ?? 0).toLocaleString("pt-BR")} g`,
          Status: product.active ? "Ativo" : "Inativo",
          Acao: (
            <Button type="button" className="border-rose-300/30 bg-rose-300/10 text-rose-100" onClick={() => deactivate(product.id)}>
              <Trash2 className="size-4" />
              Inativar
            </Button>
          )
        }))}
      />
    </div>
  );
}
