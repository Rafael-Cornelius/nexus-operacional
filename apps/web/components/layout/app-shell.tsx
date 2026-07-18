"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Factory, LogOut, Search, UserCircle2 } from "lucide-react";
import { navigation, NavigationRole } from "@/lib/navigation";
import { cn } from "@/lib/format";
import { DEMO_MODE, fetchCurrentSession, getSession, logoutSession, SessionUser } from "@/services/api";

const basePath = "/nexus-operacional";

function getAppPathname(pathname: string) {
  const withoutBasePath = pathname === basePath
    ? "/"
    : pathname.startsWith(`${basePath}/`)
      ? pathname.slice(basePath.length)
      : pathname;

  return withoutBasePath.length > 1 ? withoutBasePath.replace(/\/+$/, "") : withoutBasePath;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const appPathname = getAppPathname(pathname);
  const isLogin = appPathname === "/login";
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkingSession, setCheckingSession] = useState(!isLogin);
  const visibleNavigation = navigation.filter((item) => user?.roles.some((role) => item.roles.includes(role as NavigationRole)));

  useEffect(() => {
    let active = true;

    async function verifySession() {
      if (isLogin) {
        setCheckingSession(false);
        setUser(null);
        return;
      }

      setCheckingSession(true);
      try {
        const session = await fetchCurrentSession();
        if (!active) return;
        setUser(session.user);
      } catch {
        if (!active) return;
        setUser(null);
        router.replace(`/login?next=${encodeURIComponent(appPathname)}`);
      } finally {
        if (active) setCheckingSession(false);
      }
    }

    setUser(getSession()?.user ?? null);
    verifySession();

    return () => {
      active = false;
    };
  }, [appPathname, isLogin, router]);

  async function logout() {
    await logoutSession().catch(() => undefined);
    setUser(null);
    router.push("/login");
    router.refresh();
  }

  if (isLogin) {
    return <main>{children}</main>;
  }

  if (checkingSession) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#070b12] px-4 text-sm text-slate-300">
        Validando sessao...
      </main>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen nexus-grid">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-72 border-r border-[var(--line)] bg-[#07101d]/90 px-4 py-5 backdrop-blur-xl lg:block">
        <Link href="/" className="mb-7 flex items-center gap-3 px-2">
          <div className="grid size-10 place-items-center rounded-lg border border-cyan-300/30 bg-cyan-300/10">
            <Factory className="size-5 text-cyan-200" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-wide">NEXUS</div>
            <div className="text-xs uppercase text-slate-400">Operacional</div>
          </div>
        </Link>
        <nav className="nexus-scrollbar flex max-h-[calc(100vh-120px)] flex-col gap-1 overflow-y-auto pr-1">
          {visibleNavigation.map((item) => {
            const Icon = item.icon;
            const active = appPathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-300 transition",
                  active && "bg-cyan-300/[0.12] text-white ring-1 ring-cyan-200/20",
                  !active && "hover:bg-white/[0.06] hover:text-white"
                )}
              >
                <Icon className="size-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[#07101d]/72 px-4 py-3 backdrop-blur-xl lg:px-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase text-cyan-200/80">Centro de comando industrial</p>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold">NEXUS OPERACIONAL</h1>
                {DEMO_MODE ? <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">Preview ao vivo</span> : null}
              </div>
            </div>
            <div className="hidden min-w-80 items-center gap-2 rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm text-slate-400 md:flex">
              <Search className="size-4" />
              <span>Buscar por semana, produto, OP, setor ou motivo</span>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/login" className="hidden items-center gap-2 rounded-md border border-[var(--line)] bg-white/5 px-3 py-2 text-sm text-slate-300 md:flex">
                <UserCircle2 className="size-4" />
                <span>{user ? user.name : "Entrar"}</span>
              </Link>
              {user ? (
                <button type="button" onClick={logout} className="grid size-9 place-items-center rounded-md border border-[var(--line)] bg-white/5 text-slate-300 transition hover:text-white" aria-label="Sair">
                  <LogOut className="size-4" />
                </button>
              ) : null}
            </div>
          </div>
        </header>
        <main className="px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
