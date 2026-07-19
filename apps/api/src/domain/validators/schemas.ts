import { z } from "zod";

export const uuidSchema = z.string().uuid();

export const productWeightConfigSchema = z.object({
  formula: z.enum(["BOX_WEIGHT", "PACKAGE_WEIGHT"]).default("BOX_WEIGHT"),
  packageWeightKg: z.coerce.number().nonnegative(),
  boxWeightKg: z.coerce.number().positive(),
  packagesPerBox: z.coerce.number().int().positive(),
  massWeightKg: z.coerce.number().nonnegative(),
  targetPackageWeightG: z.coerce.number().positive(),
  overweightTolerancePercent: z.coerce.number().nonnegative().default(0.02)
});

export const productionEntrySchema = z.object({
  weekId: uuidSchema,
  sector: z.enum(["P1", "P2"]),
  lineId: uuidSchema.optional(),
  equipmentId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  date: z.coerce.date(),
  productId: uuidSchema,
  productionOrder: z.string().min(1).max(80),
  plannedBatches: z.coerce.number().nonnegative(),
  realizedBatches: z.coerce.number().nonnegative(),
  usedReworkKg: z.coerce.number().nonnegative().optional().default(0),
  packedBoxes: z.coerce.number().nonnegative(),
  weighingLossKg: z.coerce.number().nonnegative().optional().default(0),
  generatedReworkKg: z.coerce.number().nonnegative().optional().default(0),
  averagePackageWeightG: z.coerce.number().nonnegative().optional(),
  notes: z.string().max(2000).optional()
});

export const productionPreviewSchema = z.object({
  sector: z.enum(["P1", "P2"]),
  plannedBatches: z.coerce.number().nonnegative(),
  realizedBatches: z.coerce.number().nonnegative(),
  usedReworkKg: z.coerce.number().nonnegative().optional().default(0),
  packedBoxes: z.coerce.number().nonnegative(),
  weighingLossKg: z.coerce.number().nonnegative().optional().default(0),
  generatedReworkKg: z.coerce.number().nonnegative().optional().default(0),
  averagePackageWeightG: z.coerce.number().nonnegative().optional(),
  weightConfig: productWeightConfigSchema,
  pricePerKg: z.coerce.number().nonnegative().optional().default(0)
});

export const productSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(2).max(240),
  defaultSector: z.enum(["P1", "P2"]),
  packageWeightKg: z.coerce.number().nonnegative(),
  boxWeightKg: z.coerce.number().positive(),
  packagesPerBox: z.coerce.number().int().positive(),
  massWeightKg: z.coerce.number().nonnegative(),
  targetPackageWeightG: z.coerce.number().positive(),
  unit: z.string().default("kg"),
  overweightTolerancePercent: z.coerce.number().nonnegative().default(0.02),
  formula: z.enum(["BOX_WEIGHT", "PACKAGE_WEIGHT"]).default("BOX_WEIGHT"),
  packageFilmWeightG: z.coerce.number().nonnegative().default(0),
  notes: z.string().max(2000).optional()
}).strict();

export const lossEntrySchema = z.object({
  weekId: uuidSchema,
  date: z.coerce.date(),
  sector: z.enum(["P1", "P2"]).optional(),
  productId: uuidSchema.optional(),
  productionOrderId: uuidSchema.optional(),
  equipmentId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  lossTypeId: uuidSchema,
  quantityKg: z.coerce.number().nonnegative(),
  filmShift1Kg: z.coerce.number().nonnegative().optional(),
  filmShift2Kg: z.coerce.number().nonnegative().optional(),
  boxLossUnits: z.coerce.number().int().nonnegative().optional(),
  boxLossShift1Units: z.coerce.number().int().nonnegative().optional(),
  boxLossShift2Units: z.coerce.number().int().nonnegative().optional(),
  packedBoxes: z.coerce.number().nonnegative().optional().default(0),
  reason: z.string().max(240).optional(),
  notes: z.string().max(2000).optional()
});

export const dosageCheckSchema = z.object({
  weekId: uuidSchema,
  productId: uuidSchema,
  sector: z.enum(["P1", "P2"]),
  equipmentId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  operatorId: uuidSchema.optional(),
  date: z.coerce.date(),
  sampleWeightsG: z.array(z.coerce.number().positive()).min(1).max(100),
  notes: z.string().max(2000).optional()
});

export const productPricePeriodSchema = z.object({
  startsOn: z.coerce.date(),
  endsOn: z.coerce.date().nullable().optional(),
  pricePerKg: z.coerce.number().positive("Informe um preco por quilograma maior que zero."),
  filmCostPerKg: z.coerce.number().nonnegative().default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Informe a moeda com tres letras, por exemplo BRL."),
  origin: z.string().trim().min(2, "Informe a origem do preco.").max(120),
  observation: z.string().trim().max(2000).nullable().optional()
}).strict().refine((value) => !value.endsOn || value.endsOn >= value.startsOn, {
  message: "O fim do período não pode ser anterior ao início.",
  path: ["endsOn"]
});

export const productPriceApprovalSchema = z.object({
  recordVersion: z.coerce.number().int().positive(),
  reason: z.string().trim().min(5, "Informe um motivo com pelo menos 5 caracteres.").max(1000)
}).strict();

export const productPriceRetirementSchema = productPriceApprovalSchema;

export const downtimeEntrySchema = z.object({
  weekId: uuidSchema,
  date: z.coerce.date(),
  sector: z.enum(["P1", "P2"]),
  lineId: uuidSchema.optional(),
  equipmentId: uuidSchema.optional(),
  shiftId: uuidSchema.optional(),
  productionStart: z.coerce.date(),
  productionEnd: z.coerce.date(),
  downtimeStart: z.coerce.date(),
  downtimeEnd: z.coerce.date(),
  producedMassKg: z.coerce.number().nonnegative(),
  downtimeReasonId: uuidSchema,
  notes: z.string().max(2000).optional()
});

export type ProductionEntryInput = z.infer<typeof productionEntrySchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type ProductionPreviewInput = z.infer<typeof productionPreviewSchema>;
