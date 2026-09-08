export const browserApiCorsAllowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "x-mic-sc-prism-credential",
  "x-mic-sc-session",
] as const;
