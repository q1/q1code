/**
 * Fork-owned settings search entries and their visibility. The Prism
 * entries live here and reach `SETTINGS_SEARCH_ITEMS` through one spread
 * seam, so `searchableSetting(id)` knows them and a drifted id fails
 * typecheck. An entry behind a feature flag is listed with that flag, so
 * search never lands on a section that is not rendered. Entries without a
 * flag (the `base` ones) are always visible.
 */
import { readForkFlag, type ForkFlagKey } from "@t3tools/client-runtime/fork";
import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

import type {
  SettingsSearchItem,
  SettingsSearchItemId,
} from "~/components/settings/settingsSearch";

/** Sections of the Prism tab, in page order. */
export const FORK_PRISM_SETTINGS_SEARCH_ITEMS = [
  {
    id: "prism-status",
    title: "Proxy status",
    to: "/settings/prism",
    searchTerms: ["cliproxy prism proxy sidecar external mode base url version ready failed"],
  },
  {
    id: "prism-usage-source",
    title: "Show on Usage → Limits",
    to: "/settings/prism",
    searchTerms: [
      "cliproxy prism usage limits quota pooled accounts publish usage provider source",
    ],
  },
  {
    id: "prism-restart",
    title: "Restart proxy",
    to: "/settings/prism",
    searchTerms: ["cliproxy prism sidecar relaunch reconnect re-check"],
  },
  {
    id: "prism-accounts",
    title: "Accounts",
    to: "/settings/prism",
    searchTerms: ["cliproxy prism proxy pool oauth claude codex weight enabled requests"],
  },
  {
    id: "prism-add-account",
    title: "Add account",
    to: "/settings/prism",
    searchTerms: ["cliproxy prism add account login oauth device code codex claude xai kimi"],
  },
  {
    id: "prism-routing-strategy",
    title: "Routing strategy",
    to: "/settings/prism",
    searchTerms: ["cliproxy prism round robin weighted fill first load balancing"],
  },
  {
    id: "prism-sync",
    title: "Sync",
    to: "/settings/prism",
    searchTerms: ["cliproxy prism replica primary interval last sync cross-machine"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

const FORK_SEARCH_ITEM_FLAGS: Partial<Record<SettingsSearchItemId, ForkFlagKey>> =
  Object.fromEntries(FORK_PRISM_SETTINGS_SEARCH_ITEMS.map((item) => [item.id, "prism"]));

/** Predicate for the primary environment's capabilities; upstream entries always pass. */
export const isForkSettingsSearchItemVisible =
  (capabilities: Pick<ExecutionEnvironmentCapabilities, "forkFlags"> | null | undefined) =>
  (item: SettingsSearchItem): boolean => {
    const flag = FORK_SEARCH_ITEM_FLAGS[item.id as SettingsSearchItemId];
    return flag === undefined || readForkFlag(capabilities, flag);
  };
