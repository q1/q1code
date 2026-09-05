import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  MIC_IDENTITY_SESSION_HEADER,
  MicIdentityForbiddenError,
  MicIdentityUnauthorizedError,
  MicIdentityUnavailableError,
} from "@q1code/core/micIdentity";
import { MicPrismCredential } from "@q1code/core/micPrismApi";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http";
import { requireEnvironmentScope } from "../../auth/http.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ForkFlagsService } from "../ForkFlags.ts";
import { MicIdentityFetch, requireMicIdentity } from "./MicIdentityAccess.ts";
import { registerMicPrismThread, revokeMicPrismThread } from "./MicPrismThreads.ts";

const encodeCredentialRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ serviceInstanceId: Schema.String, pairingRevision: Schema.Int }),
  ),
);
const decodeCredential = Schema.decodeUnknownEffect(MicPrismCredential);

/** Environment authority admits execution; mic.sc authority admits only inference. */
export const connectMicPrismThreadRequest = Effect.fn("connectMicPrismThreadRequest")(
  function* (threadId: string) {
    const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
    const flags = yield* ForkFlagsService;
    const activeFlags = yield* flags.current;
    if (!activeFlags["mic-identity"] || !activeFlags.prism)
      return yield* new MicIdentityUnavailableError({ reason: "configuration" });
    const access = yield* requireMicIdentity("prism:inference");
    if (!access?.session.sessionId || !access.discovery.service)
      return yield* new MicIdentityUnauthorizedError({ reason: "invalid-session" });
    const service = access.discovery.service;
    const config = (yield* flags.config)["mic-identity"]!;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fetchAuthority = yield* MicIdentityFetch;
    const body = yield* encodeCredentialRequest({
      serviceInstanceId: service.id,
      pairingRevision: service.pairingRevision,
    }).pipe(Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })));
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchAuthority(`${config.authorityUrl.replace(/\/$/, "")}/v1/prism/credentials`, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal,
          headers: {
            authorization: `Bearer ${request.headers[MIC_IDENTITY_SESSION_HEADER]}`,
            "content-type": "application/json",
          },
          body,
        }),
      catch: () => new MicIdentityUnavailableError({ reason: "transport" }),
    });
    if (response.status === 401)
      return yield* new MicIdentityUnauthorizedError({ reason: "invalid-session" });
    if (response.status === 403)
      return yield* new MicIdentityForbiddenError({ capability: "prism:inference" });
    if (!response.ok) return yield* new MicIdentityUnavailableError({ reason: "transport" });
    const raw = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new MicIdentityUnavailableError({ reason: "invalid-response" }),
    });
    const credential = yield* decodeCredential(raw).pipe(
      Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (
      credential.serviceInstanceId !== service.id ||
      credential.pairingRevision !== service.pairingRevision ||
      credential.expiresAt <= now ||
      credential.expiresAt > now + 930_000
    )
      return yield* new MicIdentityUnavailableError({ reason: "invalid-response" });
    const optionalSessions = yield* Effect.serviceOption(SessionStore);
    if (Option.isNone(optionalSessions))
      return yield* new MicIdentityUnavailableError({ reason: "configuration" });
    const sessions = optionalSessions.value;
    const verify = sessions.listActive().pipe(
      Effect.map((all) =>
        all.some(
          (session) =>
            session.sessionId === principal.sessionId &&
            session.scopes.includes(AuthOrchestrationOperateScope),
        ),
      ),
      Effect.orElseSucceed(() => false),
    );
    const binding = {
      environmentSessionId: principal.sessionId,
      subject: access.session.subject,
      sessionId: access.session.sessionId,
      threadId,
      serviceInstanceId: service.id,
      pairingRevision: service.pairingRevision,
      inferenceOrigin: service.inferenceUrl,
    };
    return yield* Effect.tryPromise({
      try: (signal) =>
        registerMicPrismThread({
          binding,
          credential: { binding, token: credential.token, expiresAt: credential.expiresAt },
          verifyEnvironment: () => Effect.runPromise(verify),
          signal,
        }),
      catch: () => new MicIdentityForbiddenError({ capability: "prism:inference" }),
    });
  },
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
      }),
    ),
);

/** A failed Clerk sign-out must still be able to discard its environment-local broker. */
export const disconnectMicPrismThreadRequest = Effect.fn("disconnectMicPrismThreadRequest")(
  function* (threadId: string) {
    const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
    yield* Effect.tryPromise({
      try: () => revokeMicPrismThread(threadId, principal.sessionId),
      catch: () => new MicIdentityForbiddenError({ capability: "prism:inference" }),
    });
    return { threadId, expiresAt: 0 };
  },
);
