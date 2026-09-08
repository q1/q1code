import type { MicPrismAvailability } from "@q1code/core/micPrismApi";
import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import { describeMicPrismAvailability, readForkFlag } from "@t3tools/client-runtime/fork";
import type { ModelOption } from "../../lib/modelOptions";

export type MicPrismModelObservation = { value: MicPrismAvailability | null; error: string | null };

export function isMicPrismModel(
  config: ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
) {
  if (
    !selection ||
    !readForkFlag(config?.environment.capabilities, "prism") ||
    !readForkFlag(config?.environment.capabilities, "mic-identity")
  )
    return false;
  const driver =
    config?.providers.find((provider) => provider.instanceId === selection.instanceId)?.driver ??
    config?.settings.providerInstances[selection.instanceId]?.driver;
  return (
    (driver === "codex" || driver === "claudeAgent") &&
    selection.options?.find((option) => option.id === "prism-route")?.value !== "direct"
  );
}

export function applyMicPrismModelAvailability(
  config: ServerConfig | null | undefined,
  options: ReadonlyArray<ModelOption>,
  selection: ModelSelection | null,
  observation: MicPrismModelObservation,
): ReadonlyArray<ModelOption> {
  return options.map((original) => {
    const route =
      selection?.instanceId === original.selection.instanceId
        ? selection.options?.find((option) => option.id === "prism-route")
        : undefined;
    const option = route
      ? {
          ...original,
          selection: {
            ...original.selection,
            options: [
              ...(original.selection.options ?? []).filter((entry) => entry.id !== "prism-route"),
              route,
            ],
          },
        }
      : original;
    if (!isMicPrismModel(config, option.selection)) return option;
    const status = observation.value?.models.find((model) => model.id === option.selection.model);
    return {
      ...option,
      isUnavailable: option.isUnavailable || Boolean(observation.error) || !status?.available,
      subtitle:
        observation.error ??
        (status
          ? describeMicPrismAvailability(status)
          : "Prism eligibility has not been verified."),
    };
  });
}
