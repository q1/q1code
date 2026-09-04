/**
 * Process-wide handoff between the proxy service and the provider seams. There
 * is exactly one proxy per server process (the sidecar or the configured
 * external one), and the seams run in fibers whose context predates it
 * (provider adapters are built before it is ready), so the endpoint is
 * published here instead of through the Effect context. Set only while the
 * proxy is ready; cleared on every other state.
 */
export interface PrismEndpoint {
  /** The proxy origin: `http://127.0.0.1:<port>` for the sidecar, `prism.external.baseUrl` otherwise. No trailing slash. */
  readonly baseUrl: string;
  readonly apiKey: string;
}

let published: PrismEndpoint | undefined;

export const publishPrismEndpoint = (endpoint: PrismEndpoint | undefined): void => {
  published = endpoint;
};

export const currentPrismEndpoint = (): PrismEndpoint | undefined => published;

/**
 * The `ClaudeHome.ts` seam. Returns `env` itself (same object) when the proxy is
 * not ready so flags-off behaviour is byte-identical, otherwise a copy that
 * points Claude Code at the proxy. `ANTHROPIC_AUTH_TOKEN` is the bearer form
 * Claude Code sends as `Authorization`, which is what CLIProxyAPI expects.
 */
export const withPrismClaudeEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const endpoint = published;
  if (endpoint === undefined) return env;
  return {
    ...env,
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_AUTH_TOKEN: endpoint.apiKey,
  };
};
