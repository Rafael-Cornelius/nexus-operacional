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
  pricePerKg: z.coerce.number().nonnegative().default(0),
  filmCostPerKg: z.coerce.number().nonnegative().default(0),
  packageFilmWeightG: z.coerce.number().nonnegative().default(0),
  notes: z.string().max(2000).optional()
});

export const lossEntrySchema = z.object({
  weekId: uuidSchema,
  date: z.coerce.date(),
  sector: z.enum(["P1", "P2"]).optional(),
  productId: uuidSchema.optional(),
  productionOrderId: uuidSchema.optional(),
  lossTypeId: uuidSchema,
  quantityKg: z.coerce.number().nonnegative(),
  packedBoxes: z.coerce.number().nonnegative().optional().default(0),
  reason: z.string().max(240).optional(),
  notes: z.string().max(2000).optional()
});

export const dosageCheckSchema = z.object({
  weekId: uuidSchema,
  productId: uuidSchema,
  sector: z.enum(["P1", "P2"]),
  date: z.coerce.date(),
  sampleWeightsG: z.array(z.coerce.number().positive()).min(1).max(100),
  notes: z.string().max(2000).optional()
});

export const productPricePeriodSchema = z.object({
  startsOn: z.coerce.date(),
  endsOn: z.coerce.date().optional(),
  pricePerKg: z.coerce.number().nonnegative(),
  filmCostPerKg: z.coerce.number().nonnegative().default(0)
}).refine((value) => !value.endsOn || value.endsOn >= value.startsOn, {
  message: "O fim do período não pode ser anterior ao início.",
  path: ["endsOn"]
});

export const downtimeEntrySchema = z.object({
  weekId: uuidSchema,
  date: z.coerce.date(),
  sector: z.enum(["P1", "P2"]),
  lineId: uuidSchema.optional(),
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
