export interface OperationalGoalAlert {
  metric: string;
  value?: number;
  target: number;
  comparator?: string;
  status: string;
}

export interface GoalVisualState {
  status?: string;
  hint: string;
}

export function uniqueOperationalGoal(alerts: OperationalGoalAlert[], metrics: string[]) {
  const matches = alerts.filter((alert) => metrics.includes(alert.metric));
  return matches.length === 1 ? matches[0] : undefined;
}

export function goalVisualState(
  alerts: OperationalGoalAlert[],
  metrics: string[],
  formatTarget: (target: number) => string
): GoalVisualState {
  const matches = alerts.filter((alert) => metrics.includes(alert.metric));

  if (matches.length === 0) {
    return { hint: "Sem meta ativa configurada." };
  }

  if (matches.length > 1) {
    return {
      hint: `${matches.length} metas ativas; consulte a tabela de alertas para os alvos e status.`
    };
  }

  const [goal] = matches;
  const comparator = goal.comparator?.trim() || "alvo";
  return {
    status: goal.status,
    hint: `Meta ${comparator} ${formatTarget(goal.target)}`
  };
}
