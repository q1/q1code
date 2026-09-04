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

/** This option controls q1code routing and must never be sent to a provider CLI. */
export const withoutPrismRoute = (
  selection: ModelSelection | undefined,
): ModelSelection | undefined =>
  selection?.options?.some((option) => option.id === PRISM_ROUTE_OPTION)
    ? {
        ...selection,
        options: selection.options.filter((option) => option.id !== PRISM_ROUTE_OPTION),
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
