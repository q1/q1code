import { PRISM_API_PATHS } from "@q1code/core/prismApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/unstable/http";
import * as ForkFlags from "../ForkFlags.ts";

const routes = Object.entries(PRISM_API_PATHS).map(([name, path]) => ({
  name,
  pattern: new RegExp(`^${path.replace(/:[^/]+/g, "[^/]+")}/?$`),
}));

/** Choose before CORS short-circuits OPTIONS; retain upstream origin policy verbatim. */
export const prismBrowserApiCors = (options: Parameters<typeof HttpMiddleware.cors>[0]) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const flags = yield* ForkFlags.ForkFlagsService;
      const baseline = HttpMiddleware.cors(options);
      return <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "OPTIONS") return yield* baseline(app);
          const route = routes.find(({ pattern }) => pattern.test(request.url.split("?")[0]!));
          if (!route) return yield* baseline(app);
          const active = yield* flags.current;
          if (!active.prism || (route.name.startsWith("identity") && !active["mic-identity"]))
            return yield* baseline(app);
          const methods =
            route.name === "identityThread"
              ? ["PUT", "DELETE"]
              : route.name === "routing" || route.name === "usageSource"
                ? ["PUT"]
                : route.name === "account"
                  ? ["PATCH", "DELETE"]
                  : route.name === "accountsLoginSession"
                    ? ["DELETE"]
                    : [];
          const headers = active["mic-identity"] ? ["x-mic-sc-session"] : [];
          if (route.name === "identityThread") headers.push("x-mic-sc-prism-credential");
          return yield* HttpMiddleware.cors({
            ...options,
            allowedMethods: [...(options?.allowedMethods ?? []), ...methods],
            allowedHeaders: [...(options?.allowedHeaders ?? []), ...headers],
          })(app);
        });
    }),
    { global: true },
  ).pipe(Layer.provide(ForkFlags.layer));
