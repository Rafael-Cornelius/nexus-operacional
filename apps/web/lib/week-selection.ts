export interface SelectableWeek {
  id: string;
}

export function resolveExplicitWeekId(weeks: SelectableWeek[], requestedWeekId: string) {
  if (!requestedWeekId) return "";
  return weeks.some((week) => week.id === requestedWeekId) ? requestedWeekId : "";
}
