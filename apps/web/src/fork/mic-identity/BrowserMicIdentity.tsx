import { ClerkProvider } from "@clerk/react";
import { MicIdentitySession } from "./MicIdentitySession";

export default function BrowserMicIdentity({
  publishableKey,
}: {
  readonly publishableKey: string;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <MicIdentitySession />
    </ClerkProvider>
  );
}
