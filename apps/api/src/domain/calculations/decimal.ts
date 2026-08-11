import { Prisma } from "@prisma/client";

export type DecimalInput = Prisma.Decimal | number | string | null | undefined;

export function nonNegativeDecimal(value: DecimalInput): Prisma.Decimal {
  try {
    const decimal = new Prisma.Decimal(value ?? 0);
    return decimal.isFinite() && decimal.isPositive() ? decimal : new Prisma.Decimal(0);
  } catch {
    return new Prisma.Decimal(0);
  }
}

export function finiteDecimal(value: DecimalInput): Prisma.Decimal {
  try {
    const decimal = new Prisma.Decimal(value ?? 0);
    return decimal.isFinite() ? decimal : new Prisma.Decimal(0);
  } catch {
    return new Prisma.Decimal(0);
  }
}

export function decimalNumber(value: Prisma.Decimal, precision: number): number {
  return value.toDecimalPlaces(precision, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

export function sumDecimalNumbers(precision: number, ...values: DecimalInput[]): number {
  const total = values.reduce<Prisma.Decimal>(
    (sum, value) => sum.plus(finiteDecimal(value)),
    new Prisma.Decimal(0)
  );
  return decimalNumber(total, precision);
}
