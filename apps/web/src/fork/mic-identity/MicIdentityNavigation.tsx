import { lazy, Suspense } from "react";
import { AlertCircleIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { isElectron } from "~/env";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useMicIdentityConfig } from "./useMicIdentityConfig";

const Identity = lazy(() =>
  isElectron ? import("./ElectronMicIdentity") : import("./BrowserMicIdentity"),
);
const SharedIdentity = lazy(() =>
  import("./MicIdentitySession").then((module) => ({ default: module.MicIdentitySession })),
);

/** Hosted builds or a paired environment supply the mic.sc issuer/key. */
export function MicIdentityNavigation() {
  const { config, error, retry } = useMicIdentityConfig();
  const key = config?.enabled ? config.clerkPublishableKey : null;
  const existingKey = hasCloudPublicConfig()
    ? (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined)
    : undefined;
  const incompatible = existingKey && key && existingKey !== key;
  if (error || incompatible)
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          disabled={Boolean(incompatible)}
          onClick={retry}
          tooltip={
            incompatible
              ? "This client uses a different sign-in service. Configure it for mic.sc before connecting."
              : (error ?? "mic.sc sign-in is unavailable on this environment")
          }
        >
          <AlertCircleIcon />
          <span>mic.sc unavailable</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  return key ? (
    <Suspense fallback={null}>
      {existingKey ? <SharedIdentity /> : <Identity publishableKey={key} />}
    </Suspense>
  ) : null;
}
