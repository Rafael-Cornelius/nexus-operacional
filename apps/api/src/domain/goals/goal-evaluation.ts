import { recommendedAction } from "../alerts/alert-engine";
import type { AlertStatus } from "../calculations/types";

export const canonicalGoalMetrics = [
  "yield",
  "overweight",
  "losses_kg",
  "downtime_minutes",
  "produced_kg"
] as const;

export type CanonicalGoalMetric = (typeof canonicalGoalMetrics)[number];
export type GoalComparator = "<=" | ">=" | "<" | ">" | "=";

const goalMetricAliases: Record<string, CanonicalGoalMetric> = {
  yield: "yield",
  yield_percent: "yield",
  overweight: "overweight",
  overweight_percent: "overweight",
  losses_kg: "losses_kg",
  loss_kg: "losses_kg",
  loss: "losses_kg",
  downtime_minutes: "downtime_minutes",
  stopped_minutes: "downtime_minutes",
  downtime: "downtime_minutes",
  produced_kg: "produced_kg",
  production_kg: "produced_kg"
};

export function normalizeGoalMetric(metric: string): CanonicalGoalMetric | null {
  return goalMetricAliases[metric.trim().toLowerCase()] ?? null;
}

export function goalSatisfies(value: number, target: number, comparator: GoalComparator) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return false;
  if (comparator === ">=") return value >= target;
  if (comparator === "<") return value < target;
  if (comparator === ">") return value > target;
  if (comparator === "=") return value === target;
  return value <= target;
}

export function goalProgress(value: number, target: number, comparator: GoalComparator) {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return 0;
  if (goalSatisfies(value, target, comparator)) return 1;
  if (target === 0) return 0;
  if (comparator === ">=" || comparator === ">") {
    return clamp(value / target);
  }
  if (comparator === "=") {
    return clamp(1 - Math.abs(value - target) / Math.abs(target));
  }
  if (value === 0) return 1;
  return clamp(target / value);
}

export function evaluateOperationalGoal(input: {
  metric: CanonicalGoalMetric;
  value: number;
  target: number;
  comparator: GoalComparator;
}) {
  const achieved = goalSatisfies(input.value, input.target, input.comparator);
  const status = classifyGoalStatus(input.value, input.target, input.comparator, achieved);
  return {
    achieved,
    progress: goalProgress(input.value, input.target, input.comparator),
    status,
    action: recommendedAction(alertCategory(input.metric), status)
  };
}

function classifyGoalStatus(
  value: number,
  target: number,
  comparator: GoalComparator,
  achieved: boolean
): AlertStatus {
  if (!Number.isFinite(value) || !Number.isFinite(target)) return "CRITICAL";
  if (achieved) return "OK";

  if (target === 0) {
    // A relative deviation cannot be calculated around zero. A strict boundary
    // missed exactly at zero is a near miss; any non-zero deviation is critical.
    return value === target ? "MEDIUM" : "CRITICAL";
  }

  const scale = Math.abs(target);
  if (comparator === ">=" || comparator === ">") {
    const deviation = Math.max((target - value) / scale, 0);
    if (deviation <= 0.05) return "MEDIUM";
    if (deviation <= 0.1) return "ATTENTION";
    return "CRITICAL";
  }
  if (comparator === "<=" || comparator === "<") {
    const deviation = Math.max((value - target) / scale, 0);
    if (deviation <= 0.1) return "MEDIUM";
    if (deviation <= 0.25) return "ATTENTION";
    return "CRITICAL";
  }

  const deviation = Math.abs(value - target) / scale;
  if (deviation <= 0.05) return "MEDIUM";
  if (deviation <= 0.1) return "ATTENTION";
  return "CRITICAL";
}

function alertCategory(metric: CanonicalGoalMetric) {
  if (metric === "yield") return "yield" as const;
  if (metric === "overweight") return "overweight" as const;
  if (metric === "downtime_minutes") return "downtime" as const;
  if (metric === "produced_kg") return "production" as const;
  return "loss" as const;
}

function clamp(value: number) {
  return Math.min(Math.max(value, 0), 1);
}
