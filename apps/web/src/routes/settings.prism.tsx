// fork: cliproxy (fork-owned file)
import { createFileRoute } from "@tanstack/react-router";

import { CliProxySettingsPanel } from "../fork/cliproxy/CliProxySettingsPanel";

export const Route = createFileRoute("/settings/prism")({
  component: CliProxySettingsPanel,
});
