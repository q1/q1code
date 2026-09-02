import { readForkFlag, type ForkFlagKey } from "@t3tools/client-runtime/fork";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentServerConfig } from "../state/entities";

/** Value of a fork flag on one environment; registry default until its config arrives. */
export function useForkFlag(environmentId: EnvironmentId | null, key: ForkFlagKey): boolean {
  const config = useEnvironmentServerConfig(environmentId);
  return readForkFlag(config?.environment.capabilities, key);
}
