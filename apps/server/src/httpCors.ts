// fork: prism — scoped remote thread connect/disconnect preflights.
export const browserApiCorsAllowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "x-mic-sc-prism-credential", // fork: prism
  "x-mic-sc-session", // fork: prism
] as const;
