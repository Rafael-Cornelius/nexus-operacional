import { nonNegative, round } from "./safe-number";

export interface ProductionCosts {
  unitPricePerKg: number;
  productionCost: number;
  lossesCost: number;
  overweightCost: number;
}

export function calculateProductionCosts(input: {
  producedKg: number;
  weighingLossKg: number;
  overweightKg: number;
  pricePerKg: number;
}): ProductionCosts {
  const unitPricePerKg = round(nonNegative(input.pricePerKg), 4);
  return {
    unitPricePerKg,
    productionCost: round(nonNegative(input.producedKg) * unitPricePerKg, 2),
    lossesCost: round(nonNegative(input.weighingLossKg) * unitPricePerKg, 2),
    overweightCost: round(nonNegative(input.overweightKg) * unitPricePerKg, 2)
  };
}

export interface PackagingLossCalculation {
  lossCost: number;
  filmUsedKg: number;
  filmUsedValue: number;
  financialResult: number;
}

export function calculatePackagingLoss(input: {
  quantityKg: number;
  unitCost: number;
  packedBoxes?: number | null;
  packagesPerBox?: number | null;
  packageFilmWeightG?: number | null;
  filmCostPerKg?: number | null;
}): PackagingLossCalculation {
  const quantityKg = nonNegative(input.quantityKg);
  const unitCost = nonNegative(input.unitCost);
  const filmCostPerKg = nonNegative(input.filmCostPerKg ?? 0);
  const filmUsedKg = round(
    (nonNegative(input.packedBoxes ?? 0) * nonNegative(input.packagesPerBox ?? 0) * nonNegative(input.packageFilmWeightG ?? 0)) / 1000,
    3
  );
  const lossCost = round(quantityKg * unitCost, 2);
  const filmUsedValue = round(filmUsedKg * filmCostPerKg, 2);
  return {
    lossCost,
    filmUsedKg,
    filmUsedValue,
    financialResult: round(filmUsedValue - lossCost, 2)
  };
}
