import { BadRequestException } from "@nestjs/common";

interface WeekBoundary {
  status: string;
  startsOn: Date;
  endsOn: Date;
}

export function utcDateOnly(value: Date) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function isWeekWritable(status: string) {
  return status === "OPEN" || status === "REVIEW";
}

export function assertWeekWritable(week: Pick<WeekBoundary, "status">, message = "Semana fechada ou arquivada nao aceita alteracoes.") {
  if (!isWeekWritable(week.status)) throw new BadRequestException(message);
}

export function assertDateWithinWeek(date: Date, week: Pick<WeekBoundary, "startsOn" | "endsOn">, message: string) {
  const target = utcDateOnly(date);
  if (target < utcDateOnly(week.startsOn) || target > utcDateOnly(week.endsOn)) {
    throw new BadRequestException(message);
  }
}
