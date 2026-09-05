// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - This isolated Node HTTP adapter owns socket and native-fetch cancellation deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

/** Established only after independent environment and mic.sc authorization. */
export interface PrismInferenceBinding {
  readonly environmentSessionId: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly serviceInstanceId: string;
  readonly pairingRevision: number;
  readonly inferenceOrigin: string;
}

export interface PrismBrokerCredential {
  readonly binding: PrismInferenceBinding;
  readonly token: string;
  readonly expiresAt: number;
}

export interface PrismInferenceBrokerOptions {
  readonly binding: PrismInferenceBinding;
  /** Verify the original environment session/actor still owns this thread binding. */
  readonly verifyBinding: (binding: PrismInferenceBinding, signal: AbortSignal) => Promise<boolean>;
  /** Renew through the connected client's fresh Clerk session; never substitute another actor. */
  readonly getCredential: (
    binding: PrismInferenceBinding,
    signal: AbortSignal,
  ) => Promise<PrismBrokerCredential>;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const fields = [
  "environmentSessionId",
  "subject",
  "sessionId",
  "threadId",
  "serviceInstanceId",
  "pairingRevision",
  "inferenceOrigin",
] as const;
const postPaths = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/messages",
  "/v1/messages?beta=true",
  "/v1/messages/count_tokens",
  "/v1/messages/count_tokens?beta=true",
  "/v1/responses",
  "/v1/responses/compact",
]);
const requestHeaders = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
];
const responseHeaders = ["content-type", "retry-after", "x-request-id", "request-id"];
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}

function fail(response: NodeHttp.ServerResponse, status: number, code: string) {
  if (response.destroyed) return;
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-prism-fallback-allowed": "false",
  });
  response.end(JSON.stringify({ error: { code }, prism: { fallbackAllowed: false } }));
}

async function readBody(request: NodeHttp.IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    signal.throwIfAborted();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Stream bytes unchanged except exact known credentials, including across chunk boundaries. */
async function relay(
  body: ReadableStream<Uint8Array>,
  response: NodeHttp.ServerResponse,
  secrets: readonly string[],
  signal: AbortSignal,
) {
  const needles = secrets.map((secret) => Buffer.from(secret));
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  const write = async (bytes: Buffer) => {
    if (bytes.length && !response.write(bytes))
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          response.off("drain", drained);
          signal.removeEventListener("abort", aborted);
        };
        const drained = () => {
          cleanup();
          resolve();
        };
        const aborted = () => {
          cleanup();
          reject(new Error("Prism request cancelled."));
        };
        response.once("drain", drained);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await abortable(reader.read(), signal);
      pending = Buffer.concat([pending, next.done ? Buffer.alloc(0) : Buffer.from(next.value)]);
      for (const needle of needles) {
        let at = pending.indexOf(needle);
        while (at !== -1) {
          pending = Buffer.concat([
            pending.subarray(0, at),
            Buffer.from("[redacted]"),
            pending.subarray(at + needle.length),
          ]);
          at = pending.indexOf(needle, at + 10);
        }
      }
      let keep = 0;
      if (!next.done) {
        for (const needle of needles) {
          for (let n = Math.min(needle.length - 1, pending.length); n > keep; n--) {
            if (pending.subarray(pending.length - n).equals(needle.subarray(0, n))) {
              keep = n;
              break;
            }
          }
        }
      }
      await write(pending.subarray(0, pending.length - keep));
      pending = pending.subarray(pending.length - keep);
      if (next.done) break;
    }
    response.end();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * One process-local provider endpoint per authorized thread. Its random key grants
 * only this binding; it is not a Prism credential and must not be persisted.
 * The caller must revoke when its environment/session/identity binding ends.
 * Gateway stream leases independently enforce live mic.sc and host revocation.
 */
export async function createPrismInferenceBroker(options: PrismInferenceBrokerOptions) {
  const binding = Object.freeze({ ...options.binding });
  const origin = new URL(binding.inferenceOrigin);
  if (
    origin.origin !== binding.inferenceOrigin ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    ) ||
    !Number.isSafeInteger(binding.pairingRevision) ||
    binding.pairingRevision < 1 ||
    fields.some(
      (field) => field !== "pairingRevision" && (!binding[field] || /[\r\n]/.test(binding[field])),
    )
  ) {
    throw new Error("Invalid Prism inference binding.");
  }
  const apiKey = NodeCrypto.randomBytes(32).toString("base64url");
  const fetchGateway = options.fetch ?? globalThis.fetch;
  const lifetime = new AbortController();
  let closed = false;
  let expectedHost = "";
  const server = NodeHttp.createServer((request, response) => {
    const run = async () => {
      if (closed) return fail(response, 403, "prism_binding_revoked");
      if (request.headers.origin || request.headers.host !== expectedHost)
        return fail(response, 403, "prism_origin_denied");
      const target = request.url ?? "";
      if (
        !(
          (request.method === "GET" && target === "/v1/models") ||
          (request.method === "POST" && postPaths.has(target))
        )
      )
        return fail(response, 404, "prism_route_unavailable");
      const bearer = request.headers.authorization;
      const apiHeader = request.headers["x-api-key"];
      if (
        (!bearer && !apiHeader) ||
        (bearer && !equalSecret(bearer, `Bearer ${apiKey}`)) ||
        (apiHeader && (typeof apiHeader !== "string" || !equalSecret(apiHeader, apiKey)))
      )
        return fail(response, 401, "prism_authentication_required");
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      request.on("aborted", abort);
      response.on("close", abort);
      const signal = AbortSignal.any([lifetime.signal, disconnected.signal]);
      // Verification and renewal may involve browser RPC; abandoned callbacks
      // must not hold a request open or authorize after their deadline.
      const admission = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      try {
        const checked = await abortable(options.verifyBinding(binding, admission), admission);
        if (!checked) {
          closed = true;
          lifetime.abort();
          return fail(response, 403, "prism_binding_revoked");
        }
        const credential = await abortable(options.getCredential(binding, admission), admission);
        admission.throwIfAborted();
        if (
          fields.some((field) => credential.binding[field] !== binding[field]) ||
          credential.token.length > 8192 ||
          !/^msp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential.token) ||
          !Number.isSafeInteger(credential.expiresAt) ||
          credential.expiresAt <= Date.now() ||
          credential.expiresAt > Date.now() + 930_000
        )
          return fail(response, 403, "prism_credential_invalid");
        const headers = new Headers({ authorization: `Bearer ${credential.token}` });
        for (const name of requestHeaders) {
          const value = request.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        const body =
          request.method === "POST"
            ? await abortable(readBody(request, admission), admission)
            : undefined;
        admission.throwIfAborted();
        if (credential.expiresAt <= Date.now())
          return fail(response, 401, "prism_credential_expired");
        const headerDeadline = new AbortController();
        const timeout = setTimeout(() => headerDeadline.abort(), 30_000);
        let upstream: Response;
        try {
          const upstreamSignal = AbortSignal.any([signal, headerDeadline.signal]);
          upstream = await abortable(
            fetchGateway(`${binding.inferenceOrigin}${target}`, {
              method: request.method,
              headers,
              ...(body ? { body } : {}),
              redirect: "error",
              credentials: "omit",
              cache: "no-store",
              signal: upstreamSignal,
            }),
            upstreamSignal,
          );
        } finally {
          clearTimeout(timeout);
        }
        signal.throwIfAborted();
        response.statusCode = upstream.status;
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-prism-fallback-allowed", "false");
        for (const name of responseHeaders) {
          const value = upstream.headers.get(name);
          if (value && !value.includes(apiKey) && !value.includes(credential.token))
            response.setHeader(name, value);
        }
        if (upstream.body) await relay(upstream.body, response, [apiKey, credential.token], signal);
        else response.end();
      } catch {
        fail(
          response,
          closed ? 403 : 503,
          closed ? "prism_binding_revoked" : "prism_inference_unavailable",
        );
      } finally {
        request.off("aborted", abort);
        response.off("close", abort);
      }
    };
    void run().catch(() => fail(response, 503, "prism_inference_unavailable"));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Prism broker did not bind loopback.");
  expectedHost = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  const revoke = () => {
    closed = true;
    lifetime.abort();
  };
  const close = () => {
    if (!closing) {
      revoke();
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    return closing;
  };
  return {
    binding,
    endpoint: Object.freeze({ baseUrl: `http://${expectedHost}`, apiKey }),
    revoke,
    close,
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Prism request cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
