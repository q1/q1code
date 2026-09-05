# mic.sc and Prism

The `mic-identity` feature lets you sign in with mic.sc, discover its selected
Prism host and use the shared model pool. It is off by default. Your coding
environments, files, terminals and conversations retain their own access controls.

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

Open Prism and select **Sign in to mic.sc**. This uses normal Clerk session
tokens, so signing out or revoking a session can end its Prism access. An existing
Clerk configuration must use the same publishable key. A mismatch is shown rather
than replacing the client's existing account.

Hosted web clients can sign in before pairing an environment. Configure the
hosted build with `VITE_T3FORK_MIC_IDENTITY=true`, `VITE_MIC_SC_AUTHORITY_URL`
and `VITE_MIC_SC_CLERK_PUBLISHABLE_KEY`, alongside `VITE_HOSTED_APP_URL`.
These public settings are ignored outside hosted web mode. The identity authority
and Prism gateway must allow the client's exact origin. Desktop and native clients
currently obtain their public sign-in configuration from an already paired
environment. Native sign-in then persists while navigating the application.

## Use the pool

The Prism page shows your selected host and offers a one-off prompt. Choose a
model, send your prompt and stop the response when needed. This conversation is
not saved in q1code. The model catalogue is not a guarantee of available quota;
Prism checks each request. Model eligibility, usable account counts and warnings
still require a compatible aggregate API. Ordinary users do not receive account
labels, emails or per-account quota details.

## Connect a coding thread

Enable `prism` as well as `mic-identity` in the coding environment. With mic.sc
signed in, open the thread and choose **Connect thread to Prism** in the web or
desktop sidebar. Native clients provide a thread picker in Prism settings. The
thread must belong to an environment you can already operate.

Installed Claude and Codex providers can use the pool without a separate local
provider login. The connected client renews its thread credentials while it is
running. Each device has its own authorization; a queued turn cannot borrow a
replacement session's credentials. Approvals and other continuations stay bound
to the device/session that started the active provider session. A new turn can
use another authorized device signed in as the same mic.sc user.

Disconnect the thread before changing its mic.sc session or paired host. Closing
the owning client, signing out or removing its environment connection discards
the local broker. If a disconnected client cannot notify the environment,
credentials expire within fifteen minutes; the gateway independently checks live
mic.sc access and terminates revoked streams. Reconnect before sending another
pooled turn. Credentials are not saved in thread history or environment defaults.

The connection option still allows an explicit direct-provider route. Identity
mode never automatically retries a failed pooled turn using local credentials.
Grok models can be used through Prism's compatible inference API; the Grok coding
harness, Cursor, OpenCode and Antigravity retain their native direct routes.

## Manage a host

Routing controls appear only with the required permission, and changes are
confirmed by reading the service's applied value. Offline state retains the last
verified host, marks it unavailable and disables requests and edits; no writes
are queued. Account changes discard the previous account's results.

In web, desktop and native Prism settings, accounts with host-management access
can start a pairing challenge with the host's public key
and allowed HTTPS origin. The host must sign the exact challenge and serve its
proof before completion. Select the paired host explicitly afterward. Host
selection does not transfer provider credential-refresh ownership. Revoking the
selected host requires confirmation and remains available when that host is
offline. Host-management access does not require inference permission. If another
administrator changes the selection while you confirm, refresh and review it
before trying again. Expired challenges must be replaced; changes are never
replayed automatically. The current host helper does not yet automate signing a challenge issued
by this UI; host-side proof preparation is still required.

The merged gateway currently supports routing management, not remote account
onboarding, reserves or advanced settings. These controls remain unavailable.
Routing writes also need a future server-side settings-revision contract for
atomic stale-write rejection; clients currently bind the observed host and check
acknowledgment/readback.

Turning `mic-identity` off restores legacy Prism behavior when `prism` is enabled.
A production migration must separately fence external provider processes that
may already hold shared credentials. Live Clerk browser/native login, a reachable
paired host, actual provider execution and native-platform qualification remain
release acceptance checks. Enabling these flags does not deploy a service or
perform a production cutover.
