import { useNavigate } from "@tanstack/react-router";
import { WaypointsIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";
import { useForkFlag } from "../useForkFlag";
import { MicIdentityNavigation } from "../mic-identity/MicIdentityNavigation";
import { MicPrismThreadConnection } from "../mic-identity/MicPrismThreadConnection";
import { readMicIdentityBuildConfig } from "../mic-identity/publicConfig";

export function PrismNavigation() {
  const enabled = useForkFlag("prism");
  const serverIdentity = useForkFlag("mic-identity");
  const identity = serverIdentity || readMicIdentityBuildConfig()._tag !== "disabled";
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!enabled && !identity) return null;
  return (
    <>
      {identity ? <MicIdentityNavigation /> : null}
      {serverIdentity ? <MicPrismThreadConnection /> : null}
      {enabled || identity ? (
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="Prism"
            onClick={() => {
              if (isMobile) setOpenMobile(false);
              void navigate({ to: "/prism" });
            }}
          >
            <WaypointsIcon />
            <span>Prism</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : null}
    </>
  );
}
