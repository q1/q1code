# Prism accounts

Prism manages one shared pool of provider accounts. Sign in with a Claude
subscription or a ChatGPT/Codex subscription from Prism → Add account. Enable Prism in Settings first.
Grok remains available. For a remote browser, paste the completed callback URL
when the sign-in flow asks for it.

Account health shows known token expiry and refresh status. An unknown expiry
means the gateway has not supplied it. A sign-in alert means the account needs
attention; reconnect it through Add account. Disable an account to pause it and
re-enable it to restore it to the pool, or remove it to delete its credential.

Manage pooled accounts on the primary environment. Serving replicas receive an
encrypted snapshot without refresh tokens; only the primary enrolls accounts,
refreshes credentials, and applies account changes. Replicas can serve while the
primary is unreachable until their access credentials expire. They cannot take
over refresh ownership automatically.

When upgrading from the older sync protocol, upgrade the primary and all
replicas together. New replicas reject older snapshots. Start replicas with a
fresh auth directory so old refresh-capable credentials cannot run during the
transition. Transfer the latest primary state and stop the old refresh owner
before promoting another gateway.

Claude and Codex use the Prism pool by default. Choose **Connection → Direct
provider** in a thread's model options to use its local provider credentials.
For an eligible failure before output or tool activity, q1code retries once on
the local provider and shows a warning. Quota/reserve exhaustion, authentication
or permission refusals, and an explicit gateway no-fallback response do not
trigger direct retry. Output and tool effects are never replayed. Cancelling or
interrupting a turn does not trigger fallback.

The optional [mic.sc identity integration](mic-identity.md) uses the independently
authorized service API and has separate credential and acceptance requirements.

The primary gateway tracks known Claude and Codex quota observations and avoids
accounts whose observed limit has not reset. Unknown quota remains unknown
until the provider reports it. Accounts that need a new sign-in are excluded
from routing until reconnected.
