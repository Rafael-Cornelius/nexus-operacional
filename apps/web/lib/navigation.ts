import {
  Activity,
  Archive,
  BarChart3,
  Boxes,
  CalendarDays,
  ClipboardList,
  Scale,
  Database,
  FileSpreadsheet,
  Gauge,
  History,
  Lock,
  Presentation,
  Settings,
  ShieldCheck,
  Target,
  TimerReset,
  Users
} from "lucide-react";

export type NavigationRole = "ADMIN" | "MANAGER" | "SUPERVISOR" | "OPERATOR" | "VIEWER";

export const navigation = [
  { href: "/", label: "Menu principal", icon: Boxes, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"] },
  { href: "/dashboard", label: "Dashboard geral", icon: BarChart3, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "VIEWER"] },
  { href: "/producao/p1", label: "Producao P1", icon: Activity, roles: ["ADMIN", "SUPERVISOR", "OPERATOR"] },
  { href: "/producao/p2", label: "Producao P2", icon: Gauge, roles: ["ADMIN", "SUPERVISOR", "OPERATOR"] },
  { href: "/perdas", label: "Controle de perdas", icon: ClipboardList, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR"] },
  { href: "/dosagem", label: "Controle de dosagem", icon: Scale, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"] },
  { href: "/sobrepeso", label: "Sobrepeso", icon: Target, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "VIEWER"] },
  { href: "/paradas", label: "Paradas", icon: TimerReset, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR"] },
  { href: "/produtividade", label: "Produtividade", icon: Gauge, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "VIEWER"] },
  { href: "/produtos", label: "Produtos", icon: Database, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"] },
  { href: "/semanas", label: "Semanas", icon: CalendarDays, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "OPERATOR", "VIEWER"] },
  { href: "/historico", label: "Historico", icon: History, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "VIEWER"] },
  { href: "/relatorios", label: "Relatorios", icon: FileSpreadsheet, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "VIEWER"] },
  { href: "/apresentacoes", label: "Modo reuniao", icon: Presentation, roles: ["ADMIN", "MANAGER", "SUPERVISOR", "VIEWER"] },
  { href: "/metas", label: "Metas", icon: Target, roles: ["ADMIN", "MANAGER", "SUPERVISOR"] },
  { href: "/usuarios", label: "Usuarios", icon: Users, roles: ["ADMIN"] },
  { href: "/auditoria", label: "Auditoria", icon: ShieldCheck, roles: ["ADMIN", "MANAGER"] },
  { href: "/importacao", label: "Importacao Excel", icon: Archive, roles: ["ADMIN", "SUPERVISOR"] },
  { href: "/configuracoes", label: "Configuracoes", icon: Settings, roles: ["ADMIN"] },
  { href: "/backups", label: "Backups", icon: Lock, roles: ["ADMIN", "MANAGER"] }
];
