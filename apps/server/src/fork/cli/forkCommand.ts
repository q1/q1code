/**
 * `q1code fork ...` - the one CLI group the fork adds to upstream's root
 * command (the single seam in `bin.ts`). Features add subcommands here, not
 * new seams.
 */
import { Command } from "effect/unstable/cli";

import { secretCommand } from "./secret.ts";

export const forkCommand = Command.make("fork").pipe(
  Command.withDescription("q1code fork commands."),
  Command.withSubcommands([secretCommand]),
);
