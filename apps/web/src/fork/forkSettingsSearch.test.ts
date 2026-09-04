import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SEARCH_ITEMS } from "~/components/settings/settingsSearch";
import {
  FORK_PRISM_SETTINGS_SEARCH_ITEMS,
  isForkSettingsSearchItemVisible,
} from "./forkSettingsSearch";

const ids = (capabilities: Parameters<typeof isForkSettingsSearchItemVisible>[0]) =>
  SETTINGS_SEARCH_ITEMS.filter(isForkSettingsSearchItemVisible(capabilities)).map(
    (item) => item.id,
  );

const PRISM_IDS = FORK_PRISM_SETTINGS_SEARCH_ITEMS.map((item) => item.id);

describe("isForkSettingsSearchItemVisible", () => {
  it("hides the prism entries until the flag is on, and keeps every other entry", () => {
    const withoutServer = ids(undefined);
    const flagOff = ids({ forkFlags: { prism: false, "update-check": false } });
    const flagOn = ids({ forkFlags: { prism: true, "update-check": false } });
    for (const id of PRISM_IDS) {
      expect(withoutServer).not.toContain(id);
      expect(flagOff).not.toContain(id);
      expect(flagOn).toContain(id);
    }
    expect(withoutServer).toContain("q1code-feature-flags");
    expect(flagOn.length).toBe(SETTINGS_SEARCH_ITEMS.length);
    expect(flagOff.length).toBe(SETTINGS_SEARCH_ITEMS.length - PRISM_IDS.length);
  });

  it("points every prism entry at the Prism tab", () => {
    for (const item of FORK_PRISM_SETTINGS_SEARCH_ITEMS) {
      expect(item.to).toBe("/settings/prism");
    }
    expect(PRISM_IDS).toEqual([
      "prism-status",
      "prism-usage-source",
      "prism-restart",
      "prism-accounts",
      "prism-add-account",
      "prism-routing-strategy",
      "prism-sync",
    ]);
  });
});
