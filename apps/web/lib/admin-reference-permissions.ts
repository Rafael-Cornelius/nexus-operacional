export function canManageEquipment(roles: string[]) {
  return roles.some((role) => ["ADMIN", "MANAGER", "SUPERVISOR"].includes(role));
}

export function canManageShifts(roles: string[]) {
  return roles.some((role) => ["ADMIN", "MANAGER"].includes(role));
}

export function canDeactivateReference(roles: string[]) {
  return roles.includes("ADMIN");
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
