import type { ModelSelection, ProviderOptionDescriptor, ServerProvider } from "@t3tools/contracts";

export const PRISM_ROUTE_OPTION = "prism-route";
export const PRISM_ROUTE_DESCRIPTOR = {
  id: PRISM_ROUTE_OPTION,
  label: "Connection",
  type: "select",
  options: [
    { id: "prism", label: "Prism pool", isDefault: true },
    { id: "direct", label: "Direct provider" },
  ],
} satisfies ProviderOptionDescriptor;

export const prismRoute = (selection: ModelSelection | undefined): "prism" | "direct" =>
  selection?.options?.find((option) => option.id === PRISM_ROUTE_OPTION)?.value === "direct"
    ? "direct"
    : "prism";

/** An opaque server-stamped reference, never an inference or environment credential. */
export const MIC_PRISM_BINDING_OPTION = "q1.mic-binding";
export const micPrismBinding = (selection: ModelSelection | undefined): string | undefined => {
  const value = selection?.options?.find((option) => option.id === MIC_PRISM_BINDING_OPTION)?.value;
  return typeof value === "string" ? value : undefined;
};

/** Installation is required; the environment checks the signed-in thread at execution time. */
export function withMicPrismReadiness<
  A extends { readonly enabled: boolean; readonly installed: boolean },
>(snapshot: A, enabled: boolean) {
  return enabled && snapshot.enabled && snapshot.installed
    ? {
        ...snapshot,
        status: "ready" as const,
        auth: { status: "authenticated" as const, type: "prism", label: "mic.sc Prism" },
        message: "Prism available. Connect this thread with mic.sc to authorize inference.",
      }
    : snapshot;
}

/** This option controls q1code routing and must never be sent to a provider CLI. */
export const withoutPrismRoute = (
  selection: ModelSelection | undefined,
): ModelSelection | undefined =>
  selection?.options?.some(
    (option) => option.id === PRISM_ROUTE_OPTION || option.id === MIC_PRISM_BINDING_OPTION,
  )
    ? {
        ...selection,
        options: selection.options.filter(
          (option) => option.id !== PRISM_ROUTE_OPTION && option.id !== MIC_PRISM_BINDING_OPTION,
        ),
      }
    : selection;

export const withPrismRouteOption = (snapshot: ServerProvider, enabled: boolean): ServerProvider =>
  !enabled
    ? snapshot
    : {
        ...snapshot,
        models: snapshot.models.map((model) => ({
          ...model,
          capabilities: {
            ...model.capabilities,
            optionDescriptors: [
              ...(model.capabilities?.optionDescriptors ?? []).filter(
                (option) => option.id !== PRISM_ROUTE_OPTION,
              ),
              PRISM_ROUTE_DESCRIPTOR,
            ],
          },
        })),
      };
