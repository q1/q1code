import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import type { SettingsPath } from "~/components/settings/settingsSearch";
import { primaryServerConfigAtom } from "~/state/server";

import { isForkSettingsPathVisible } from "./forkSettingsNav";

/** The settings nav items whose fork flag (if any) is on for the primary environment. */
export function useForkVisibleSettingsNavItems<T extends { readonly to: SettingsPath }>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const config = useAtomValue(primaryServerConfigAtom);
  const capabilities = config?.environment.capabilities;
  return useMemo(() => {
    const visible = isForkSettingsPathVisible(capabilities);
    return items.filter((item) => visible(item.to));
  }, [capabilities, items]);
}
