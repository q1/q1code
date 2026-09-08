/** Preserve the browser origin only on the private identity relay in proxied development. */
export function withBrowserIdentityProxy<T extends Record<string, unknown>>(
  target: string,
  proxy: T,
) {
  return {
    "/api/fork/prism/identity/browser": { target, changeOrigin: false },
    ...proxy,
  };
}
