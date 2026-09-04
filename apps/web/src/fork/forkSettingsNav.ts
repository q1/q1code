/**
 * Which settings tabs the fork adds behind a flag. The sidebar nav filters
 * `SETTINGS_NAV_ITEMS` through this so an off flag shows exactly upstream's
 * tabs; the route itself stays reachable by URL and renders its own "off"
 * notice. Upstream paths always pass.
 */
import { readForkFlag, type ForkFlagKey } from "@t3tools/client-runtime/fork";
import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

import type { SettingsPath } from "~/components/settings/settingsSearch";

const FORK_SETTINGS_PATH_FLAGS: Partial<Record<SettingsPath, ForkFlagKey>> = {
  "/settings/prism": "prism",
};

export const isForkSettingsPathVisible =
  (capabilities: Pick<ExecutionEnvironmentCapabilities, "forkFlags"> | null | undefined) =>
  (path: SettingsPath): boolean => {
    const flag = FORK_SETTINGS_PATH_FLAGS[path];
    return flag === undefined || readForkFlag(capabilities, flag);
  };
