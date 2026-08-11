"use client";

import { Factory } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { isValidDemoAdminCredentials } from "@/lib/demo-auth";
import {
  apiPostClient,
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_MODE,
  DEMO_SESSION,
  saveSession,
  SessionData
} from "@/services/api";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(DEMO_MODE ? DEMO_ADMIN_EMAIL : "");
  const [password, setPassword] = useState(DEMO_MODE ? DEMO_ADMIN_PASSWORD : "");
  const [hydrated, setHydrated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setHydrated(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (DEMO_MODE) {
        if (!isValidDemoAdminCredentials(email, password, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD)) {
          throw new Error("Email ou senha invalidos.");
        }
        saveSession(DEMO_SESSION);
        router.push(searchParams.get("next") || "/dashboard");
        router.refresh();
        return;
      }

      const session = await apiPostClient<SessionData>("/auth/login", { email, password });
      saveSession(session);
      router.push(searchParams.get("next") || "/dashboard");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nao foi possivel iniciar a sessao.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="grid min-h-screen place-items-center bg-[#070b12] px-4">
      <Card className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-lg border border-cyan-300/30 bg-cyan-300/10">
            <Factory className="size-5 text-cyan-200" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">NEXUS OPERACIONAL</h1>
            <p className="text-sm text-slate-400">Sessao segura</p>
          </div>
        </div>
        <form className="space-y-4" onSubmit={submit}>
          {DEMO_MODE ? (
            <div className="space-y-3 rounded-md border border-emerald-300/25 bg-emerald-300/[0.07] p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-200">Acesso administrador do preview</p>
              <div>
                <span className="block text-xs uppercase text-slate-400">Email</span>
                <strong className="mt-1 block break-all text-sm font-medium text-slate-100">{DEMO_ADMIN_EMAIL}</strong>
              </div>
              <p className="text-sm text-slate-300">Senha carregada automaticamente. Clique em Entrar.</p>
            </div>
          ) : (
            <>
              <label className="block space-y-2">
                <span className="text-xs uppercase text-slate-400">Email</span>
                <input autoComplete="username" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 outline-none focus:border-cyan-300/60" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label className="block space-y-2">
                <span className="text-xs uppercase text-slate-400">Senha</span>
                <input type="password" autoComplete="current-password" className="w-full rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 outline-none focus:border-cyan-300/60" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Senha do usuario" />
              </label>
            </>
          )}
          {error ? <p className="rounded-md border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-sm text-rose-100">{error}</p> : null}
          <Button className="w-full" type="submit" disabled={!hydrated || loading}>
            {loading ? "Validando..." : "Entrar"}
          </Button>
        </form>
      </Card>
    </section>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="grid min-h-screen place-items-center bg-[#070b12] px-4 text-sm text-slate-300">Carregando acesso...</main>}>
      <LoginForm />
    </Suspense>
  );
}
