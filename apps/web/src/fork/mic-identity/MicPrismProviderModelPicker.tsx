import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, useSyncExternalStore, type ComponentProps } from "react";
import type { EnvironmentId, ProviderOptionSelections } from "@t3tools/contracts";
import {
  describeMicPrismAvailability,
  describeMicPrismWarning,
  readForkFlag,
} from "@t3tools/client-runtime/fork";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { serverEnvironment } from "~/state/server";
import { useMicIdentityConfig } from "./useMicIdentityConfig";
import {
  micIdentityGeneration,
  micIdentitySessionSnapshot,
  subscribeMicIdentity,
} from "./micIdentitySession";
import { useMicPrismAvailability } from "./useMicPrismAvailability";

type Props = ComponentProps<typeof ProviderModelPicker> & {
  readonly environmentId: EnvironmentId;
  readonly routeOptions:
    | Partial<Readonly<Record<string, ProviderOptionSelections>>>
    | null
    | undefined;
};

/** The fork decorates upstream's existing disabled-model seam and preserves direct-provider selection. */
export function MicPrismProviderModelPicker({ environmentId, routeOptions, ...props }: Props) {
  const server = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const { config } = useMicIdentityConfig();
  const generation = useSyncExternalStore(subscribeMicIdentity, micIdentityGeneration);
  const session = useSyncExternalStore(subscribeMicIdentity, micIdentitySessionSnapshot);
  const enabled =
    readForkFlag(server?.environment.capabilities, "prism") &&
    readForkFlag(server?.environment.capabilities, "mic-identity") &&
    session.status === "signed-in" &&
    Boolean(config?.authorityUrl);
  if (!enabled || !config?.authorityUrl) return <ProviderModelPicker {...props} />;
  return (
    <PoolPicker
      key={`${config.authorityUrl}:${generation}:${environmentId}`}
      {...props}
      authorityUrl={config.authorityUrl}
      generation={generation}
      routeOptions={routeOptions}
    />
  );
}

function PoolPicker({
  authorityUrl,
  generation,
  routeOptions,
  ...props
}: Omit<Props, "environmentId"> & { authorityUrl: string; generation: number }) {
  const availability = useMicPrismAvailability({ authorityUrl, generation, disabled: false });
  const pooled = (instanceId: string) => {
    const driver = props.instanceEntries.find(
      (entry) => entry.instanceId === instanceId,
    )?.driverKind;
    return (
      (driver === "codex" || driver === "claudeAgent") &&
      routeOptions?.[instanceId]?.find((option) => option.id === "prism-route")?.value !== "direct"
    );
  };
  const models = useMemo(
    () => new Map(availability.value?.models.map((model) => [model.id, model]) ?? []),
    [availability.value],
  );
  const selected = models.get(props.model);
  const modelOptionsByInstance = new Map(props.modelOptionsByInstance);
  for (const [instanceId, options] of modelOptionsByInstance) {
    if (!pooled(instanceId)) continue;
    const decorated = options.map((option) => ({
      ...option,
      isUnavailable:
        option.isUnavailable || Boolean(availability.error) || !models.get(option.slug)?.available,
    }));
    if (
      instanceId === props.activeInstanceId &&
      props.model &&
      !decorated.some(
        (option) => option.slug === props.model || option.aliases?.includes(props.model),
      )
    ) {
      decorated.push({ slug: props.model, name: props.model, isUnavailable: !selected?.available });
    }
    modelOptionsByInstance.set(instanceId, decorated);
  }
  const reason = (
    instanceId: Parameters<NonNullable<Props["getModelDisabledReason"]>>[0],
    model: string,
  ) => {
    const existing = props.getModelDisabledReason?.(instanceId, model);
    if (existing || !pooled(instanceId)) return existing ?? null;
    if (availability.error) return "Prism availability is stale. Check the Prism connection.";
    if (!availability.value) return "Checking Prism model availability…";
    const status = models.get(model);
    return status?.available
      ? null
      : describeMicPrismWarning(status?.reason ?? "Model unavailable from Prism");
  };
  return (
    <>
      <ProviderModelPicker
        {...props}
        modelOptionsByInstance={modelOptionsByInstance}
        getModelDisabledReason={reason}
      />
      {pooled(props.activeInstanceId) ? (
        <details className="relative text-xs text-muted-foreground">
          <summary
            className="cursor-pointer list-none whitespace-nowrap px-1"
            aria-label="Prism model status"
          >
            Prism ·{" "}
            {availability.error
              ? "Offline"
              : selected
                ? `${selected.available ? "Ready" : "Unavailable"} · ${selected.usableAccounts}`
                : availability.value
                  ? "Unavailable · 0"
                  : "Checking…"}
          </summary>
          <div className="absolute bottom-full right-0 z-50 mb-2 w-64 space-y-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md">
            <p>
              {availability.error ??
                (selected
                  ? describeMicPrismAvailability(selected)
                  : "The selected model has no verified Prism eligibility.")}
            </p>
            {selected?.warnings.map((warning) => (
              <p key={warning}>{describeMicPrismWarning(warning)}</p>
            ))}
            <Link className="underline" to="/prism">
              Open Prism accounts and settings
            </Link>
          </div>
        </details>
      ) : null}
    </>
  );
}
