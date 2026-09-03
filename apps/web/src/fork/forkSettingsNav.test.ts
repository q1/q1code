import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SECTION_LABELS, type SettingsPath } from "~/components/settings/settingsSearch";
import { isForkSettingsPathVisible } from "./forkSettingsNav";

const ALL_PATHS = Object.keys(SETTINGS_SECTION_LABELS) as ReadonlyArray<SettingsPath>;
const UPSTREAM_PATHS = ALL_PATHS.filter((path) => path !== "/settings/prism");

describe("isForkSettingsPathVisible", () => {
  it("hides the Prism tab until the cliproxy flag is on", () => {
    expect(isForkSettingsPathVisible(undefined)("/settings/prism")).toBe(false);
    expect(isForkSettingsPathVisible(null)("/settings/prism")).toBe(false);
    expect(
      isForkSettingsPathVisible({ forkFlags: { cliproxy: false, "update-check": false } })(
        "/settings/prism",
      ),
    ).toBe(false);
    expect(
      isForkSettingsPathVisible({ forkFlags: { cliproxy: true, "update-check": false } })(
        "/settings/prism",
      ),
    ).toBe(true);
  });

  it("always shows upstream's tabs, in their order", () => {
    const flagOff = isForkSettingsPathVisible({
      forkFlags: { cliproxy: false, "update-check": false },
    });
    expect(ALL_PATHS.filter(flagOff)).toEqual(UPSTREAM_PATHS);
    expect(ALL_PATHS.filter(isForkSettingsPathVisible(undefined))).toEqual(UPSTREAM_PATHS);
    const flagOn = isForkSettingsPathVisible({
      forkFlags: { cliproxy: true, "update-check": false },
    });
    expect(ALL_PATHS.filter(flagOn)).toEqual(ALL_PATHS);
  });
});
