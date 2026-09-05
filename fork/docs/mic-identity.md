# mic.sc and Prism

The `mic-identity` feature connects a q1code client to its mic.sc
account and discovers that account's designated Prism service. It is off by
default. Signing in does not grant access to an environment, another person's
conversations, files, or terminals.

Enable it only with a compatible mic.sc identity authority and Prism gateway.
Configure the public authority URL and Clerk publishable key in the environment's
`fork.json`:

```json
{
  "flags": { "mic-identity": true },
  "mic-identity": {
    "authorityUrl": "https://identity.example.com",
    "clerkPublishableKey": "pk_live_REPLACE_WITH_PUBLIC_KEY"
  }
}
```

Open Prism and sign in to mic.sc. The Clerk application must provide its `convex`
token template. A client already configured for a different Clerk application
reports that mismatch; its existing sign-in and environment connections are not
silently replaced. The native clients require matching application configuration.
Hosted web clients can sign in before connecting an environment. Enable the
hosted build with `VITE_T3FORK_MIC_IDENTITY=true`,
`VITE_MIC_SC_AUTHORITY_URL`, and `VITE_MIC_SC_CLERK_PUBLISHABLE_KEY`, alongside
the normal `VITE_HOSTED_APP_URL` configuration. These are public settings and
are ignored outside hosted web mode. Desktop and native clients retain their
separate environment-pairing prerequisite.

Admitted users can discover the paired service and check their access. Routing
controls appear only with the relevant service permission. Changes are shown as
applied only after the gateway acknowledges them. When the service cannot be
reached, its last known state is marked offline and changes are disabled; edits
are never queued. Sign-out or account changes discard the previous account's
results. Management access to Prism does not grant q1code administration.

The current gateway contract provides status and routing. It does not yet report
model availability, usable account counts, or provider warnings, and does not
provide remote account login or advanced settings. The client labels those
limitations. Ordinary users do not receive provider-account details.

Coding-session routing with mic.sc credentials requires a session credential
broker and is not available yet. Enabling identity mode stops the legacy shared
key route and its pooled Usage source; it cannot substitute those credentials
for a signed-in user. Existing direct-provider connections remain available.
Turning `mic-identity` off restores the legacy Prism integration when `prism`
is enabled. A production migration must separately fence existing external
provider processes that may already hold shared credentials.

Revocation must reject new requests and terminate affected active streams. The
service enforces inference authorization; client visibility checks cannot
replace it. Real Clerk sign-in, provider inference, renewal, stream revocation,
and native-platform acceptance remain release gates. This feature does not
pair or transfer refresh ownership, install services, or perform a cutover.
