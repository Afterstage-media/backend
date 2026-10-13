export const log = (level: "info" | "warn" | "error", message: string, metadata: Record<string, unknown> = {}) => {
  const entry = {
    at: new Date().toISOString(),
    level,
    service: "medio-under-social-manager",
    message,
    ...metadata,
  };
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(JSON.stringify(entry));
};
