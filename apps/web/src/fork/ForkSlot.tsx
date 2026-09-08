import type { ComponentProps } from "react";
import { MicPrismProviderModelPicker } from "./mic-identity/MicPrismProviderModelPicker";

type PickerProps = ComponentProps<typeof MicPrismProviderModelPicker>;
type SlotProps = {
  name: "chat-model-picker";
  context: Pick<PickerProps, "environmentId" | "routeOptions">;
} & Omit<PickerProps, "environmentId" | "routeOptions">;

/** Named composer extension boundary; picker ownership and flag-off fallback stay in the fork. */
export function ForkSlot({ name, context, ...props }: SlotProps) {
  switch (name) {
    case "chat-model-picker":
      return <MicPrismProviderModelPicker {...props} {...context} />;
  }
}
