import { useAtomValue } from "@effect/atom-react";
import { readForkFlag, type ForkFlagKey } from "@t3tools/client-runtime/fork";
import { primaryServerConfigAtom } from "~/state/server";

/** Value of a fork flag on the primary environment; registry default until its config arrives. */
export function useForkFlag(key: ForkFlagKey): boolean {
  const config = useAtomValue(primaryServerConfigAtom);
  return readForkFlag(config?.environment.capabilities, key);
}
