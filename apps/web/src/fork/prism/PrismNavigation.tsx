import { useNavigate } from "@tanstack/react-router";
import { WaypointsIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "~/components/ui/sidebar";
import { useForkFlag } from "../useForkFlag";

export function PrismNavigation() {
  const enabled = useForkFlag("prism");
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!enabled) return null;
  return (
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
  );
}
