export function isValidDemoAdminCredentials(
  inputEmail: string,
  inputPassword: string,
  configuredEmail: string,
  configuredPassword: string
) {
  if (!configuredEmail || !configuredPassword) return false;

  return (
    inputEmail.trim().toLowerCase() === configuredEmail.trim().toLowerCase() &&
    inputPassword.trim() === configuredPassword
  );
}
