/**
 * Client-side read of the fork feature flags the server publishes through
 * `ExecutionEnvironmentCapabilities.forkFlags`. Upstream servers omit the key,
 * so every flag reads as its registry default against them.
 */
import { FORK_FLAGS, type ForkFlagKey } from "@q1code/core/flags";
import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";

export type { ForkFlagKey } from "@q1code/core/flags";

export const readForkFlag = (
  capabilities: Pick<ExecutionEnvironmentCapabilities, "forkFlags"> | null | undefined,
  key: ForkFlagKey,
): boolean => capabilities?.forkFlags?.[key] ?? FORK_FLAGS[key].default;
