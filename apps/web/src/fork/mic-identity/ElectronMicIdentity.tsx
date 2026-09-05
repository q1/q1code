import { ClerkProvider } from "@clerk/electron/react";
import { passkeys } from "@clerk/electron/passkeys";
import { MicIdentitySession } from "./MicIdentitySession";

export default function ElectronMicIdentity({
  publishableKey,
}: {
  readonly publishableKey: string;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey} passkeys={passkeys}>
      <MicIdentitySession />
    </ClerkProvider>
  );
}
