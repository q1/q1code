const PATH = "/api/fork/prism/identity/browser";
type Binding = { authority: string; authorization: string | null };
let binding: Binding | undefined;
export const readBrowserIdentityAuthority = () => binding?.authority ?? null;
export function bindBrowserIdentityRelay(next: Binding) {
  binding = next;
  return () => {
    if (binding === next) binding = undefined;
  };
}
export async function browserIdentityRequest(
  operation: string,
  body: unknown = {},
  generation?: string,
  signal?: AbortSignal | null,
): Promise<Response> {
  const current = binding;
  if (!current) throw new Error("Sign-in requires an environment connection.");
  const response = await globalThis.fetch(PATH + "/" + operation, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...(current.authorization ? { authorization: current.authorization } : {}),
      ...(generation ? { "x-q1-prism-generation": generation } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
  });
  if (binding !== current) throw new Error("Environment connection changed.");
  return response;
}
/** Only opaque relay handles use this path. Native Clerk and inference credentials retain their transport. */
export const browserIdentityFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const token = headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token?.startsWith("q1br_")) return globalThis.fetch(input, init);
  const body = init?.body == null ? undefined : await new Response(init.body).text();
  return browserIdentityRequest(
    "proxy",
    {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      body,
    },
    token,
    init?.signal,
  );
};
