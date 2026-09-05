import { ClerkProvider } from "@clerk/react";
import { clerkAppearance } from "~/components/clerk/clerkAppearance";
import { MicIdentitySession } from "./MicIdentitySession";

export default function BrowserMicIdentity({
  publishableKey,
}: {
  readonly publishableKey: string;
}) {
  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
      <MicIdentitySession />
    </ClerkProvider>
  );
}
