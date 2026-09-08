import * as NodeCrypto from "node:crypto";
import {
  MIC_IDENTITY_API_PATHS,
  MicIdentityWire,
  MicPrismDiscoveryWire,
} from "@q1code/core/micIdentity";
import { MIC_PRISM_PAIRING_PATHS } from "@q1code/core/micPrismPairing";
import * as Schema from "effect/Schema";

const decodeIdentity = Schema.decodeUnknownSync(MicIdentityWire);
const decodeDiscovery = Schema.decodeUnknownSync(MicPrismDiscoveryWire);

export const BROWSER_IDENTITY_PATH = "/api/fork/prism/identity/browser";
const COOKIE = "q1_prism_browser";
const random = () => NodeCrypto.randomBytes(32).toString("base64url");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const json = (body: unknown, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
type Session = {
  environment: string;
  origin: string;
  authority: string;
  generation: string;
  expires: number;
  pending?: { requestId: string; state: string; verifier: string };
  grant?: string;
};

/** Process memory only. A browser handle is useless without its private cookie and environment session. */
export class BrowserIdentityRelay {
  private readonly sessions = new Map<string, Session>();
  private readonly transport: (
    input: string | Request | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  constructor(
    transport: (
      input: string | Request | URL,
      init?: RequestInit,
    ) => Promise<Response> = globalThis.fetch,
  ) {
    this.transport = transport;
  }

  callback(): Response {
    const nonce = random();
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>Prism sign-in</title><p>Return to q1code to finish signing in.</p><script nonce="${nonce}">const p=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);if(window.opener&&[...p].length===3&&['code','state','requestId'].every(k=>p.getAll(k).length===1)){window.opener.postMessage({type:'q1code:prism-browser-callback',code:p.get('code'),state:p.get('state'),requestId:p.get('requestId')},location.origin);}</script>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        },
      },
    );
  }

  private async upstream(session: Session, path: string, body?: unknown) {
    return this.transport(session.authority + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        ...(session.grant ? { "x-prism-client": session.grant } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async handle(request: Request, environment: string, authority: string): Promise<Response> {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      // All private endpoints are POST; browsers supply Origin even on same-origin requests.
      if (
        request.method !== "POST" ||
        origin !== url.origin ||
        request.headers.get("content-type") !== "application/json"
      )
        return json({}, 403);
      if (
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
            url.port)
        )
      )
        return json({}, 403);
      const now = Math.floor(performance.timeOrigin + performance.now());
      for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);
      const cookie = request.headers
        .get("cookie")
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(COOKIE + "="))
        ?.slice(COOKIE.length + 1);
      let session = cookie ? this.sessions.get(cookie) : undefined;
      if (
        session &&
        (session.environment !== environment ||
          session.origin !== origin ||
          session.authority !== authority)
      )
        session = undefined;
      const operation = url.pathname.slice(BROWSER_IDENTITY_PATH.length + 1);
      const reader = request.body?.getReader();
      let raw = "",
        bytes = 0;
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1_048_576) {
            await reader.cancel();
            return json({}, 413);
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      }
      const body: unknown = JSON.parse(raw);
      if (!record(body)) return json({}, 400);
      if (operation === "start") {
        if (this.sessions.size >= 512) return json({}, 429);
        if (session) {
          this.sessions.delete(cookie!);
          if (session.grant)
            await this.upstream(session, "/v1/prism/cli/revoke", {}).then((r) => r.body?.cancel());
        }
        const id = random(),
          verifier = random(),
          state = random(),
          requestId = NodeCrypto.randomUUID();
        session = {
          environment,
          origin,
          authority,
          generation: "q1br_" + random(),
          expires: now + 300_000,
          pending: { verifier, state, requestId },
        };
        this.sessions.set(id, session);
        const login = new URL("https://prism.mic.sc/browser-login");
        login.hash = new URLSearchParams({
          requestId,
          state,
          challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
          redirectUri: origin + BROWSER_IDENTITY_PATH + "/callback",
        }).toString();
        return json({ loginUrl: login.href }, 200, {
          "set-cookie": `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`,
        });
      }
      if (!session) return operation === "status" ? json({ generation: null }) : json({}, 401);
      if (operation === "revoke") {
        // Retain only enough memory to retry upstream revocation; never authorize more proxy work.
        delete session.pending;
        session.generation = "revoked";
        if (session.grant) {
          const response = await this.upstream(session, "/v1/prism/cli/revoke", {});
          if (!response.ok) return json({}, 503);
        }
        this.sessions.delete(cookie!);
        return json({}, 200, {
          "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        });
      }
      if (operation === "complete") {
        const pending = session.pending;
        if (
          !pending ||
          pending.state !== body.state ||
          pending.requestId !== body.requestId ||
          typeof body.code !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(body.code)
        )
          return json({}, 403);
        delete session.pending;
        const response = await this.upstream(session, "/v1/prism/cli/exchange", {
          requestId: pending.requestId,
          verifier: pending.verifier,
          code: body.code,
        });
        if (!response.ok) return json({}, 401);
        const grant: unknown = await response.json();
        if (
          !record(grant) ||
          grant.version !== 1 ||
          grant.tokenType !== "PrismClient" ||
          typeof grant.token !== "string" ||
          !/^msc1\.[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(grant.token) ||
          typeof grant.expiresAt !== "number" ||
          grant.expiresAt <= now ||
          grant.expiresAt > now + 7 * 86_400_000 + 30_000
        )
          return json({}, 502);
        // Do not resurrect a session revoked while the exchange was in flight.
        if (this.sessions.get(cookie!) !== session || session.generation === "revoked") {
          // The authority can finish exchange after local logout or replacement. Retire that grant too.
          await this.upstream({ ...session, grant: grant.token }, "/v1/prism/cli/revoke", {})
            .then((result) => result.body?.cancel())
            .catch(() => undefined);
          return json({}, 401);
        }
        session.grant = grant.token;
        session.expires = grant.expiresAt;
      }
      if (!session.grant || session.generation === "revoked")
        return operation === "status" ? json({ generation: null }) : json({}, 401);
      const identityResponse = await this.upstream(session, MIC_IDENTITY_API_PATHS.session);
      if (identityResponse.status === 401 || identityResponse.status === 403) {
        this.sessions.delete(cookie!);
        return json({}, 401);
      }
      if (!identityResponse.ok) return json({}, 503);
      const identity = decodeIdentity(await identityResponse.json());
      if (
        identity.authorizationExpiresAt <= Math.floor(performance.timeOrigin + performance.now())
      ) {
        this.sessions.delete(cookie!);
        return json({}, 401);
      }
      if (this.sessions.get(cookie!) !== session || session.generation === "revoked")
        return json({}, 401);
      if (operation === "complete" || operation === "status")
        return json({ generation: session.generation });
      if (
        operation !== "proxy" ||
        request.headers.get("x-q1-prism-generation") !== session.generation ||
        typeof body.url !== "string" ||
        typeof body.method !== "string"
      )
        return json({}, 403);
      const target = new URL(body.url);
      if (target.username || target.password || target.hash || target.search) return json({}, 403);
      const authorityPaths: string[] = [
        ...Object.values(MIC_IDENTITY_API_PATHS),
        ...Object.values(MIC_PRISM_PAIRING_PATHS),
      ];
      const authorityTarget =
        target.origin === authority && authorityPaths.includes(target.pathname);
      let allowed =
        authorityTarget &&
        (body.method === "GET"
          ? [MIC_IDENTITY_API_PATHS.session, MIC_IDENTITY_API_PATHS.prismService].includes(
              target.pathname as typeof MIC_IDENTITY_API_PATHS.session,
            )
          : body.method === "POST" &&
            target.pathname !== MIC_IDENTITY_API_PATHS.session &&
            target.pathname !== MIC_IDENTITY_API_PATHS.prismService);
      if (!authorityTarget) {
        const discoveryResponse = await this.upstream(session, MIC_IDENTITY_API_PATHS.prismService);
        if (!discoveryResponse.ok) return json({}, discoveryResponse.status === 401 ? 401 : 503);
        const discovery = decodeDiscovery(await discoveryResponse.json());
        const service = discovery.service;
        allowed =
          !!service &&
          service.apiOrigin.replace(/\/$/, "") === target.origin &&
          /^(GET|POST|PUT|PATCH|DELETE)$/.test(body.method) &&
          /^\/prism\/v1\/(status|routing|settings|models\/availability|accounts(?:\/(?:login(?:\/[A-Za-z0-9_.~-]+(?:\/callback)?)?|[A-Za-z0-9_.~-]+))?)$/.test(
            target.pathname,
          );
      }
      if (!allowed || this.sessions.get(cookie!) !== session || session.generation === "revoked")
        return json({}, 403);
      const response = await this.transport(target, {
        method: body.method,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
        headers: {
          "content-type": "application/json",
          ...(authorityTarget
            ? { "x-prism-client": session.grant }
            : { authorization: `Bearer ${session.grant}` }),
        },
        ...(body.method === "GET"
          ? {}
          : { body: typeof body.body === "string" ? body.body : "{}" }),
      });
      if (this.sessions.get(cookie!) !== session || session.generation === "revoked") {
        await response.body?.cancel();
        return json({}, 401);
      }
      if (response.status === 401) this.sessions.delete(cookie!);
      return new Response(response.body, {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      });
    } catch {
      return json({}, 503);
    }
  }
}
