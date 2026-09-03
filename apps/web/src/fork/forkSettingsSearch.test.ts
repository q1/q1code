import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SEARCH_ITEMS } from "~/components/settings/settingsSearch";
import {
  FORK_CLIPROXY_SETTINGS_SEARCH_ITEMS,
  isForkSettingsSearchItemVisible,
} from "./forkSettingsSearch";

const ids = (capabilities: Parameters<typeof isForkSettingsSearchItemVisible>[0]) =>
  SETTINGS_SEARCH_ITEMS.filter(isForkSettingsSearchItemVisible(capabilities)).map(
    (item) => item.id,
  );

const CLIPROXY_IDS = FORK_CLIPROXY_SETTINGS_SEARCH_ITEMS.map((item) => item.id);

describe("isForkSettingsSearchItemVisible", () => {
  it("hides the cliproxy entries until the flag is on, and keeps every other entry", () => {
    const withoutServer = ids(undefined);
    const flagOff = ids({ forkFlags: { cliproxy: false, "update-check": false } });
    const flagOn = ids({ forkFlags: { cliproxy: true, "update-check": false } });
    for (const id of CLIPROXY_IDS) {
      expect(withoutServer).not.toContain(id);
      expect(flagOff).not.toContain(id);
      expect(flagOn).toContain(id);
    }
    expect(withoutServer).toContain("q1code-feature-flags");
    expect(flagOn.length).toBe(SETTINGS_SEARCH_ITEMS.length);
    expect(flagOff.length).toBe(SETTINGS_SEARCH_ITEMS.length - CLIPROXY_IDS.length);
  });

  it("points every cliproxy entry at the Prism tab", () => {
    for (const item of FORK_CLIPROXY_SETTINGS_SEARCH_ITEMS) {
      expect(item.to).toBe("/settings/prism");
    }
    expect(CLIPROXY_IDS).toEqual([
      "cliproxy-status",
      "cliproxy-restart",
      "cliproxy-accounts",
      "cliproxy-add-account",
      "cliproxy-routing-strategy",
      "cliproxy-sync",
    ]);
  });
});
