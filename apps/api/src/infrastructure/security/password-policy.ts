import { z } from "zod";

const forbiddenPasswords = new Set([
  "nexusdemo@2026",
  "nexusadmin@2026",
  "password@123",
  "admin@123456",
  "replace-with-a-temporary-strong-password",
]);

function normalizedPassword(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

export const strongPasswordSchema = z
  .string()
  .min(12, "A senha deve ter pelo menos 12 caracteres.")
  .max(128, "A senha excede o tamanho permitido.")
  .regex(/[a-z]/, "A senha deve conter letra minuscula.")
  .regex(/[A-Z]/, "A senha deve conter letra maiuscula.")
  .regex(/[0-9]/, "A senha deve conter numero.")
  .regex(/[^A-Za-z0-9\s]/, "A senha deve conter simbolo.")
  .refine(
    (value) => value === value.trim(),
    "A senha nao pode iniciar ou terminar com espacos.",
  )
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "A senha excede o limite seguro do bcrypt.",
  )
  .refine(
    (value) => !forbiddenPasswords.has(normalizedPassword(value)),
    "A senha nao pode reutilizar credencial de demonstracao ou valor previsivel.",
  );
