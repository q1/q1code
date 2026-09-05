import {
  MIC_IDENTITY_API_PATHS,
  MicIdentityForbiddenError,
  MicIdentityUnauthorizedError,
  MicIdentityUnavailableError,
} from "@q1code/core/micIdentity";
import {
  MicPrismChatChunk,
  MicPrismChatInput,
  MicPrismCredential,
  MicPrismInferenceError,
  MicPrismModels,
} from "@q1code/core/micPrismApi";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  getMicIdentityAccess,
  requireCurrentMicIdentity,
  resolveMicIdentityToken,
  type MicIdentityClientInput,
} from "./micIdentityClient.ts";

const decodeChatInput = Schema.decodeUnknownEffect(MicPrismChatInput);
const decodeChatChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(MicPrismChatChunk));

const failResponse = (status: number) => {
  if (status === 401) return new MicIdentityUnauthorizedError({ reason: "invalid-session" });
  if (status === 403) return new MicIdentityForbiddenError({ capability: "prism:inference" });
  return new MicPrismInferenceError({ status, reason: "provider" });
};

/** Never return provider diagnostics, request headers or bearer material in errors. */
const execute = Effect.fn("micPrismInference.execute")(function* (
  request: HttpClientRequest.HttpClientRequest,
  timeoutMs = 30_000,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    }),
    Effect.mapError(() => new MicIdentityUnavailableError({ reason: "transport" })),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
    }),
  );
  if (response.status < 200 || response.status >= 300) return yield* failResponse(response.status);
  return response;
});

/** Exchange a freshly minted Clerk session token; never renew from an inference credential. */
export const mintMicPrismCredential = Effect.fn("mintMicPrismCredential")(
  function* (input: MicIdentityClientInput) {
    const access = yield* getMicIdentityAccess({
      ...input,
      allowUnpaired: false,
      permission: "prism:inference",
    });
    const service = access.discovery.service!;
    const token = yield* resolveMicIdentityToken(input.getToken);
    yield* requireCurrentMicIdentity(input);
    const request = HttpClientRequest.post(
      `${input.baseUrl.replace(/\/$/, "")}${MIC_IDENTITY_API_PATHS.credential}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${token}`,
        accept: "application/json",
      }),
      HttpClientRequest.bodyJsonUnsafe({
        serviceInstanceId: service.id,
        pairingRevision: service.pairingRevision,
      }),
    );
    const response = yield* execute(request);
    const credential = yield* HttpClientResponse.schemaBodyJson(MicPrismCredential)(response).pipe(
      Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
    );
    yield* requireCurrentMicIdentity(input);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (
      credential.serviceInstanceId !== service.id ||
      credential.pairingRevision !== service.pairingRevision ||
      credential.expiresAt <= now ||
      credential.expiresAt > now + 930_000
    ) {
      return yield* new MicIdentityUnavailableError({ reason: "invalid-response" });
    }
    return {
      service,
      subject: access.session.subject,
      token: Redacted.make(credential.token),
      expiresAt: credential.expiresAt,
    };
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 15_000,
        orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
      }),
    ),
);

export const listMicPrismModels = Effect.fn("listMicPrismModels")(
  function* (input: MicIdentityClientInput) {
    const credential = yield* mintMicPrismCredential(input);
    yield* requireCurrentMicIdentity(input);
    const response = yield* execute(
      HttpClientRequest.get(`${credential.service.inferenceUrl.replace(/\/$/, "")}/v1/models`).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${Redacted.value(credential.token)}`,
          accept: "application/json",
        }),
      ),
    );
    const models = yield* HttpClientResponse.schemaBodyJson(MicPrismModels)(response).pipe(
      Effect.mapError(() => new MicIdentityUnavailableError({ reason: "invalid-response" })),
    );
    yield* requireCurrentMicIdentity(input);
    return [...new Set(models.data.map(({ id }) => id))].sort();
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 15_000,
        orElse: () => Effect.fail(new MicIdentityUnavailableError({ reason: "transport" })),
      }),
    ),
);

const ChatCompletion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.NullOr(Schema.String) }),
    }),
  ),
});

/** Native transports without response streaming use the same credential boundary. */
export const completeMicPrismChat = Effect.fn("completeMicPrismChat")(
  function* (input: MicIdentityClientInput & MicPrismChatInput) {
    const body = yield* decodeChatInput(input).pipe(
      Effect.mapError(() => new MicPrismInferenceError({ status: 0, reason: "invalid-response" })),
    );
    const credential = yield* mintMicPrismCredential(input);
    yield* requireCurrentMicIdentity(input);
    const response = yield* execute(
      HttpClientRequest.post(
        `${credential.service.inferenceUrl.replace(/\/$/, "")}/v1/chat/completions`,
      ).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bearer ${Redacted.value(credential.token)}`,
          accept: "application/json",
        }),
        HttpClientRequest.bodyJsonUnsafe({ ...body, stream: false }),
      ),
      input.timeoutMs ?? 120_000,
    );
    const result = yield* HttpClientResponse.schemaBodyJson(ChatCompletion)(response).pipe(
      Effect.mapError(() => new MicPrismInferenceError({ status: 0, reason: "invalid-response" })),
    );
    yield* requireCurrentMicIdentity(input);
    if (!result.choices.length)
      return yield* new MicPrismInferenceError({ status: 0, reason: "invalid-response" });
    return result.choices.map(({ message }) => message.content ?? "").join("");
  },
  (effect, input) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: input.timeoutMs ?? 120_000,
        orElse: () => Effect.fail(new MicPrismInferenceError({ status: 0, reason: "interrupted" })),
      }),
    ),
);

/** A fresh credential per request; no storage, retries or silent model substitution. */
export const streamMicPrismChat = (input: MicIdentityClientInput & MicPrismChatInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const body = yield* decodeChatInput(input).pipe(
        Effect.mapError(
          () => new MicPrismInferenceError({ status: 0, reason: "invalid-response" }),
        ),
      );
      const credential = yield* mintMicPrismCredential(input);
      yield* requireCurrentMicIdentity(input);
      const response = yield* execute(
        HttpClientRequest.post(
          `${credential.service.inferenceUrl.replace(/\/$/, "")}/v1/chat/completions`,
        ).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${Redacted.value(credential.token)}`,
            accept: "text/event-stream",
          }),
          HttpClientRequest.bodyJsonUnsafe({ ...body, stream: true }),
        ),
      );
      if (!response.headers["content-type"]?.includes("text/event-stream")) {
        return yield* new MicPrismInferenceError({ status: 0, reason: "invalid-response" });
      }
      let data = "";
      let pendingLine = "";
      let outputLength = 0;
      let done = false;
      const parse = (line: string) =>
        Effect.gen(function* () {
          yield* requireCurrentMicIdentity(input);
          if (done) return "";
          if (line.startsWith("data:")) data += `${line.slice(5).replace(/^ /, "")}\n`;
          if (data.length > 1_048_576)
            return yield* new MicPrismInferenceError({ status: 0, reason: "invalid-response" });
          if (line !== "" || data === "") return "";
          const event = data.trimEnd();
          data = "";
          if (event === "[DONE]") {
            done = true;
            return "";
          }
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(MicPrismChatChunk),
          )(event).pipe(
            Effect.mapError(() => new MicPrismInferenceError({ status: 0, reason: "interrupted" })),
          );
          const text = decoded.choices.map(({ delta }) => delta.content ?? "").join("");
          outputLength += text.length;
          if (outputLength > 4_194_304)
            return yield* new MicPrismInferenceError({ status: 0, reason: "invalid-response" });
          return text;
        });
      return response.stream.pipe(
        Stream.mapError(() => new MicPrismInferenceError({ status: 0, reason: "interrupted" })),
        Stream.decodeText(),
        Stream.mapEffect((chunk) =>
          Effect.suspend(() => {
            pendingLine += chunk;
            if (pendingLine.length > 1_048_576)
              return Effect.fail(
                new MicPrismInferenceError({ status: 0, reason: "invalid-response" }),
              );
            const lines = pendingLine.split("\n");
            pendingLine = lines.pop() ?? "";
            return Effect.succeed(lines.map((line) => line.replace(/\r$/, "")));
          }),
        ),
        Stream.flatMap((lines) => Stream.fromIterable(lines)),
        Stream.mapEffect(parse),
        Stream.takeUntil(() => done),
        Stream.filter((text) => text.length > 0),
        Stream.concat(
          Stream.fromEffect(
            Effect.suspend(() =>
              done
                ? Effect.succeed("")
                : Effect.fail(new MicPrismInferenceError({ status: 0, reason: "interrupted" })),
            ),
          ),
        ),
      );
    }),
  );
