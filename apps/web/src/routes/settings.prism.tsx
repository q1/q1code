// fork: prism (fork-owned file)
import { createFileRoute } from "@tanstack/react-router";

import { PrismSettingsPanel } from "../fork/prism/PrismSettingsPanel";

export const Route = createFileRoute("/settings/prism")({
  component: PrismSettingsPanel,
});
