import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import * as ForkFlags from "../ForkFlags.ts";
import { micIdentityPublicConfig } from "./MicIdentityAccess.ts";
import { BROWSER_IDENTITY_PATH, BrowserIdentityRelay } from "./BrowserIdentityRelay.ts";

export const browserIdentityRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const flags = yield* ForkFlags.ForkFlagsService;
    const relay = new BrowserIdentityRelay();
    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        `${BROWSER_IDENTITY_PATH}/callback`,
        Effect.sync(() => HttpServerResponse.fromWeb(relay.callback())),
      ),
      HttpRouter.add(
        "POST",
        `${BROWSER_IDENTITY_PATH}/:operation`,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const auth = yield* EnvironmentAuth;
          const principal = yield* auth.authenticateHttpRequest(request);
          if (!principal.scopes.includes(AuthOrchestrationReadScope))
            return HttpServerResponse.empty({ status: 403 });
          const config = yield* micIdentityPublicConfig;
          if (!config.enabled || !config.authorityUrl)
            return HttpServerResponse.empty({ status: 503 });
          const web = yield* HttpServerRequest.toWeb(request);
          return HttpServerResponse.fromWeb(
            yield* Effect.promise(() =>
              relay.handle(web, principal.sessionId, config.authorityUrl!.replace(/\/$/, "")),
            ),
          );
        }).pipe(
          Effect.provideService(ForkFlags.ForkFlagsService, flags),
          Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 401 })),
        ),
      ),
    );
  }),
).pipe(Layer.provide(ForkFlags.layer));
