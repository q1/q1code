import { useAtomValue } from "@effect/atom-react";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FORK_FLAGS, FORK_FLAG_KEYS, envVarForFlag } from "@q1code/core/flags";
import { FORK_CONFIG_FILENAME } from "@q1code/core/config";
import { readForkFlag } from "@t3tools/client-runtime/fork";
import { Badge } from "~/components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { SettingsRow, useSettingsSearchTargetId } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { primaryServerConfigAtom } from "~/state/server";

const FORK_SECTION_SEARCH_ID = "q1code-feature-flags";

/**
 * Read-only view of every fork flag on the primary environment. Collapsed by
 * default like the legacy section; a settings-search jump unfolds it. Values
 * come from the server's capabilities, so an upstream server shows defaults.
 */
export function ForkSettingsSection() {
  const config = useAtomValue(primaryServerConfigAtom);
  const capabilities = config?.environment.capabilities;
  const [open, setOpen] = useState(false);
  const searchTargetId = useSettingsSearchTargetId();
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null) {
      lastExpandedTargetRef.current = null;
      return;
    }
    if (searchTargetId !== FORK_SECTION_SEARCH_ID) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setOpen(true);
  }, [searchTargetId]);

  return (
    <section className="space-y-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-8 w-full items-center gap-2 px-3 sm:px-4">
          <h2 className="text-lg font-semibold tracking-[-0.025em] text-muted-foreground transition-colors group-hover:text-foreground">
            q1code
          </h2>
          <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="relative space-y-1 overflow-visible pt-3 text-foreground">
            <SettingsRow
              {...searchableSetting(FORK_SECTION_SEARCH_ID)}
              description={`Fork features are switched with a T3FORK_* environment variable or the flags section of ${FORK_CONFIG_FILENAME} in the server's userdata directory. The environment variable wins.`}
            />
            {FORK_FLAG_KEYS.map((key) => {
              const flag = FORK_FLAGS[key];
              const enabled = readForkFlag(capabilities, key);
              return (
                <SettingsRow
                  key={key}
                  title={key}
                  description={flag.description}
                  status={
                    <span className="font-mono">
                      {envVarForFlag(key)} · {FORK_CONFIG_FILENAME} flags.{key} · scope:{" "}
                      {flag.scope}
                    </span>
                  }
                  control={
                    <Badge variant={enabled ? "success" : "outline"}>
                      {enabled ? "On" : "Off"}
                    </Badge>
                  }
                />
              );
            })}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}
