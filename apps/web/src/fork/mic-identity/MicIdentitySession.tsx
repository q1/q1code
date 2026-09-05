import { useAuth, useClerk } from "@clerk/react";
import { useEffect } from "react";
import { LogInIcon, LogOutIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { bindMicIdentitySession } from "./micIdentitySession";

export function MicIdentitySession() {
  const { getToken, isLoaded, isSignedIn, userId, sessionId } = useAuth();
  const clerk = useClerk();
  useEffect(
    () =>
      bindMicIdentitySession(
        isLoaded && isSignedIn && userId && sessionId
          ? () => getToken({ template: "convex", skipCache: true })
          : undefined,
      ),
    [getToken, isLoaded, isSignedIn, userId, sessionId],
  );
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        disabled={!isLoaded}
        onClick={() => {
          if (isSignedIn) {
            bindMicIdentitySession();
            void clerk.signOut();
          } else void clerk.openSignIn();
        }}
        tooltip={isSignedIn ? "Sign out of mic.sc" : "Sign in to mic.sc"}
      >
        {isSignedIn ? <LogOutIcon /> : <LogInIcon />}
        <span>{isSignedIn ? "Sign out of mic.sc" : "Sign in to mic.sc"}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
