/**
 * Visibility of fork-owned settings search entries. An entry registered in
 * `settingsSearch.ts` behind a feature flag is listed here with that flag, so
 * search never lands on a section that is not rendered. Entries without a
 * flag (the `base` ones) are always visible.
 */
import { readForkFlag, type ForkFlagKey } from "@t3tools/client-runtime/fork";
import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

import type {
  SettingsSearchItem,
  SettingsSearchItemId,
} from "~/components/settings/settingsSearch";

const FORK_SEARCH_ITEM_FLAGS: Partial<Record<SettingsSearchItemId, ForkFlagKey>> = {
  "cliproxy-accounts": "cliproxy",
  "cliproxy-add-account": "cliproxy",
  "cliproxy-routing-strategy": "cliproxy",
};

/** Predicate for the primary environment's capabilities; upstream entries always pass. */
export const isForkSettingsSearchItemVisible =
  (capabilities: Pick<ExecutionEnvironmentCapabilities, "forkFlags"> | null | undefined) =>
  (item: SettingsSearchItem): boolean => {
    const flag = FORK_SEARCH_ITEM_FLAGS[item.id as SettingsSearchItemId];
    return flag === undefined || readForkFlag(capabilities, flag);
  };
