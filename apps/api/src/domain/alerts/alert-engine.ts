import { AlertStatus } from "../calculations/types";

export interface AlertRuleInput {
  metric: "overweight" | "loss" | "yield" | "downtime";
  value: number;
  target: number;
}

export interface OperationalAlert extends AlertRuleInput {
  status: AlertStatus;
  action: string;
}

export function recommendedAction(metric: AlertRuleInput["metric"], status: AlertStatus): string {
  if (status === "OK") return "Manter o processo e acompanhar o indicador.";
  const actions: Record<AlertRuleInput["metric"], string> = {
    overweight: "Ajustar dosagem, conferir a pesagem e validar a média de amostras.",
    loss: "Investigar a causa, registrar a ação corretiva e revisar o processo.",
    yield: "Revisar receita, rendimento da massa e perdas de pesagem.",
    downtime: "Acionar a área responsável e eliminar a causa recorrente da parada."
  };
  return actions[metric];
}

export function evaluateRule(input: AlertRuleInput): OperationalAlert {
  const status = classifyRule(input);
  return { ...input, status, action: recommendedAction(input.metric, status) };
}

export function classifyRule(input: AlertRuleInput): AlertStatus {
  const { metric, value, target } = input;

  if (!Number.isFinite(value) || !Number.isFinite(target) || target === 0) {
    return "ATTENTION";
  }

  if (metric === "yield") {
    if (value >= target) return "OK";
    if (value >= target * 0.95) return "MEDIUM";
    if (value >= target * 0.9) return "ATTENTION";
    return "CRITICAL";
  }

  if (value <= target) return "OK";
  if (value <= target * 1.1) return "MEDIUM";
  if (value <= target * 1.25) return "ATTENTION";
  return "CRITICAL";
}
