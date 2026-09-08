# Prism integration seams and remaining debt

The September 8 refactor preserves the completed identity/Prism behavior while
moving implementation back into fork-owned modules. It does not raise the
40-file seam budget, change release versions, or authorize promotion.

- ChatComposer uses the typed `ForkSlot` named `chat-model-picker`. Its context
  supplies the owning environment and route options; existing picker props pass
  through unchanged. The slot owns the Prism picker, whose disabled-feature
  branch renders upstream's picker. The named slot is the stable extension
  boundary required by FORK.md.
- Mobile composer catalog/availability derivation and new-task catalog decoration
  live in `MicPrismAvailability`. Explicit pooled drafts use the fork resolver;
  normal selections still use upstream resolution. These hooks retain distinct
  draft and existing-thread lifecycles.
- The web development proxy wraps upstream's proxy map with one fork helper.
  Ordinary and websocket entries keep their original options; the identity
  route retains the actual browser origin.
- Settings search contributes its base entry from a fork-owned collection.
  Unrelated settings whitespace is restored.
- Release-installation tests retain upstream suite layout. The three additional
  tarball/checksum cases now live in a fork-owned test file; none were deleted.
  A named shared fixture layer removes the suite-wide indentation patch.

Temporary larger hooks remain and carry `Fork-Seam-Debt: yes`:

| Surface | Why it remains / removal condition |
| --- | --- |
| Mobile new-task flow and existing ThreadComposer | Upstream has no general model-selection/availability policy extension. Fork hooks replace local derivation and introduce status elements; the preserved context and hook ordering require more than a literal three-line patch after formatting. Replace with a generic upstream selection/availability extension when available. |
| Mobile NewTaskDraftScreen | Status element uses current draft context. Upstream candidate additionally routes immediate and queued selection resolution through the fork policy. Retain separate submission validation until upstream exposes that boundary. |
| ChatComposer slot opening | Named slot replaces the existing picker; typed environment/route context is essential to permission-aware eligibility. Its formatted opening may exceed three physical lines, but no eligibility logic lives in the composer. |
| Pinned runtime installation | Verified release staging needs error mapping and branded entry paths. Test fixtures retain minimal brand/runtime hooks. Replace with upstream pluggable release resolution and fixture support when available. |
| CORS methods/headers | Existing global preflight metadata includes scoped credential headers and PUT/DELETE regardless of flags. This is retained observable parity debt, not new authorization. Route-scoped middleware could remove it only after real-server ordering/preflight coverage proves equivalent behavior. |
| Settings path/label/icon registries and generated route table | Static typed registrations are inert until rendered through existing flag-aware navigation/search. Collapse into an upstream extension registry when one exists; do not weaken exhaustive path typing. |

File count and generated marker checks do not establish the three-line rule or
flags-off parity by themselves. Review this debt together with the current
seam report and scoped tests. Never delete lifecycle checks or integration
tests just to meet the file budget.
