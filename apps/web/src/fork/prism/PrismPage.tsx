import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { SidebarInset } from "~/components/ui/sidebar";
import { ScrollArea } from "~/components/ui/scroll-area";
import { isElectron } from "~/env";
import { PrismSettingsPanel } from "./PrismSettingsPanel";

export function PrismPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Prism</h1>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        <PrismSettingsPanel />
      </ScrollArea>
    </SidebarInset>
  );
}
