import { DecimalInput, decimalNumber, finiteDecimal, nonNegativeDecimal } from "./decimal";
import { CALCULATION_RULE_IDS, CalculationRuleVersions, calculationRuleVersions } from "./rule-registry";

export interface ProductionCosts {
  unitPricePerKg: number;
  productionCost: number;
  lossesCost: number;
  overweightCost: number;
  calculationRuleVersions: CalculationRuleVersions;
}

export function calculateProductionCosts(input: {
  producedKg: DecimalInput;
  weighingLossKg: DecimalInput;
  overweightKg: DecimalInput;
  pricePerKg: DecimalInput;
}): ProductionCosts {
  const unitPrice = nonNegativeDecimal(input.pricePerKg).toDecimalPlaces(4);
  return {
    unitPricePerKg: decimalNumber(unitPrice, 4),
    productionCost: decimalNumber(nonNegativeDecimal(input.producedKg).mul(unitPrice), 2),
    lossesCost: decimalNumber(nonNegativeDecimal(input.weighingLossKg).mul(unitPrice), 2),
    overweightCost: decimalNumber(nonNegativeDecimal(input.overweightKg).mul(unitPrice), 2),
    calculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.productionCost,
      CALCULATION_RULE_IDS.weighingLossCost,
      CALCULATION_RULE_IDS.overweightCost
    )
  };
}

export interface PackagingLossCalculation {
  lossCost: number;
  filmUsedKg: number;
  filmUsedValue: number;
  financialResult: number;
  lossOnlyFinancialResult: number;
  calculationRuleVersions: CalculationRuleVersions;
  lossCostCalculationRuleVersions: CalculationRuleVersions;
  lossOnlyCalculationRuleVersions: CalculationRuleVersions;
}

export function calculatePackagingLoss(input: {
  quantityKg: DecimalInput;
  unitCost: DecimalInput;
  packedBoxes?: DecimalInput;
  packagesPerBox?: DecimalInput;
  packageFilmWeightG?: DecimalInput;
  filmCostPerKg?: DecimalInput;
}): PackagingLossCalculation {
  const quantityKg = nonNegativeDecimal(input.quantityKg);
  const unitCost = nonNegativeDecimal(input.unitCost);
  const filmCostPerKg = nonNegativeDecimal(input.filmCostPerKg);
  const filmUsed = nonNegativeDecimal(input.packedBoxes)
    .mul(nonNegativeDecimal(input.packagesPerBox))
    .mul(nonNegativeDecimal(input.packageFilmWeightG))
    .div(1000)
    .toDecimalPlaces(3);
  const loss = quantityKg.mul(unitCost).toDecimalPlaces(2);
  const filmValue = filmUsed.mul(filmCostPerKg).toDecimalPlaces(2);
  return {
    lossCost: decimalNumber(loss, 2),
    filmUsedKg: decimalNumber(filmUsed, 3),
    filmUsedValue: decimalNumber(filmValue, 2),
    financialResult: decimalNumber(filmValue.minus(loss), 2),
    lossOnlyFinancialResult: decimalNumber(loss.negated(), 2),
    calculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.packagingFilmUsed,
      CALCULATION_RULE_IDS.packagingLossCost,
      CALCULATION_RULE_IDS.packagingFilmValue,
      CALCULATION_RULE_IDS.packagingResult
    ),
    lossCostCalculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.packagingLossCost
    ),
    lossOnlyCalculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.packagingLossCost,
      CALCULATION_RULE_IDS.lossResult
    )
  };
}

export function calculateDashboardFinancials(input: {
  productionCost: DecimalInput;
  productionTotalKg: DecimalInput;
  lossesCost: DecimalInput;
  overweightCost: DecimalInput;
}) {
  const productionCost = nonNegativeDecimal(input.productionCost);
  const productionTotalKg = nonNegativeDecimal(input.productionTotalKg);
  const lossesCost = nonNegativeDecimal(input.lossesCost);
  const overweightCost = nonNegativeDecimal(input.overweightCost);
  const costPerKg = productionTotalKg.isZero() ? finiteDecimal(0) : productionCost.div(productionTotalKg);
  return {
    totalImpactCost: decimalNumber(lossesCost.plus(overweightCost), 2),
    costPerKg: decimalNumber(costPerKg, 4),
    calculationRuleVersions: calculationRuleVersions(
      CALCULATION_RULE_IDS.dashboardTotalImpact,
      CALCULATION_RULE_IDS.dashboardCostPerKg
    )
  };
}
