/**
 * Strict Cloudflare Worker environment validation.
 * Names only are reported; secret values are never logged.
 */
export function assertRequiredEnv(env, serviceName, requiredNames) {
  const missing = requiredNames.filter((name) => {
    const value = env?.[name];
    return value === undefined || value === null || String(value).trim() === "";
  });

  if (missing.length) {
    const message = `[${serviceName}] Startup blocked: missing required environment variable(s): ${missing.join(", ")}`;
    console.error(JSON.stringify({
      level: "error",
      service: serviceName,
      event: "required_environment_missing",
      missing
    }));
    throw new Error(message);
  }
}
