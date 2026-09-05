import { ClerkProvider } from "@clerk/electron/react";
import { passkeys } from "@clerk/electron/passkeys";
import { clerkAppearance } from "~/components/clerk/clerkAppearance";
import { MicIdentitySession } from "./MicIdentitySession";

export default function ElectronMicIdentity({
  publishableKey,
}: {
  readonly publishableKey: string;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey} passkeys={passkeys}>
      <MicIdentitySession />
    </ClerkProvider>
  );
}
