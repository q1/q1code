import { useEffect, useId, useRef, useState } from "react";
import { CheckIcon, CopyIcon, KeyRoundIcon, LinkIcon, ShieldAlertIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";
import type { MicIdentityAccess } from "@q1code/core/micIdentityApi";
import type {
  MicPrismPairingChallenge,
  MicPrismPairedInstance,
} from "@q1code/core/micPrismPairing";
import {
  startMicPrismPairing,
  completeMicPrismPairing,
  selectMicPrismInstance,
  revokeMicPrismInstance,
  type MicPrismPairingClientError,
} from "@t3tools/client-runtime/fork";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { runtime } from "~/lib/runtime";
import { micIdentityGeneration, readMicIdentityToken } from "./micIdentitySession";

export interface MicPrismPairingProps {
  readonly authorityUrl: string;
  readonly generation: number;
  readonly access: MicIdentityAccess;
  readonly onChanged: () => void;
}

/** Identity changes discard the entire ceremony, including pending confirmations. */
export function MicPrismPairing(props: MicPrismPairingProps) {
  if (!props.access.session.permissions.includes("prism:instances:manage")) return null;
  return <PairingForm key={`${props.authorityUrl}:${props.generation}`} {...props} />;
}

function PairingForm({ authorityUrl, generation, access, onChanged }: MicPrismPairingProps) {
  const fieldId = useId();
  const [expanded, setExpanded] = useState(false);
  const [label, setLabel] = useState("");
  const [origin, setOrigin] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [signature, setSignature] = useState("");
  const [challenge, setChallenge] = useState<MicPrismPairingChallenge | null>(null);
  const [paired, setPaired] = useState<MicPrismPairedInstance | null>(null);
  const [confirmation, setConfirmation] = useState<{
    id: string;
    pairingRevision: number;
    label: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const isCurrent = () => micIdentityGeneration() === generation;
  const input = { baseUrl: authorityUrl, getToken: readMicIdentityToken, isCurrent };
  const service = access.discovery.service;

  const run = async <A,>(
    effect: Effect.Effect<A, MicPrismPairingClientError, HttpClient.HttpClient>,
    accept: (value: A) => void,
  ) => {
    if (pending.current || !isCurrent()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runtime.runPromise(effect.pipe(Effect.result), {
        signal: controller.signal,
      });
      if (!isCurrent() || controller.signal.aborted) return;
      if (result._tag === "Failure") {
        setError(result.failure.message);
        // Refresh authority facts on rejection; never replay a mutation.
        onChanged();
      } else accept(result.success);
    } catch {
      if (isCurrent() && !controller.signal.aborted)
        setError("This change could not be confirmed. Refresh the connection before trying again.");
    } finally {
      if (pending.current === controller) pending.current = null;
      if (isCurrent() && !controller.signal.aborted) setBusy(false);
    }
  };

  const copyChallenge = async () => {
    if (!challenge) return;
    try {
      await navigator.clipboard.writeText(challenge.challenge);
      if (isCurrent()) setCopied(true);
    } catch {
      if (isCurrent()) setError("Copy is unavailable. Select and copy the full challenge below.");
    }
  };

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-5"
      aria-labelledby={`${fieldId}-heading`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={`${fieldId}-heading`} className="flex items-center gap-2 text-sm font-semibold">
            <KeyRoundIcon className="size-4 text-muted-foreground" />
            Host administration
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Pair a host or recover the shared connection, even when the current host is offline.
          </p>
        </div>
        {!expanded ? (
          <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>
            Pair a host
          </Button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="flex items-start gap-2 text-sm">
          <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
          {notice}
        </p>
      ) : null}
      {expanded ? (
        <div className="space-y-4 border-t border-border pt-4">
          <p className="text-sm leading-6 text-muted-foreground">
            Use the host's approved origin and public verification key. The host keeps its private
            key and must serve the signed proof at that origin.
          </p>
          {!challenge && !paired ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  startMicPrismPairing({
                    ...input,
                    origin: origin.trim(),
                    publicKey: publicKey.trim(),
                    label: label.trim(),
                  }),
                  (value) => {
                    setChallenge(value);
                    setCopied(false);
                  },
                );
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs font-medium" htmlFor={`${fieldId}-label`}>
                  Host name
                  <Input
                    id={`${fieldId}-label`}
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    maxLength={80}
                    placeholder="Primary PC"
                    disabled={busy}
                    required
                  />
                </label>
                <label className="space-y-1.5 text-xs font-medium" htmlFor={`${fieldId}-origin`}>
                  Approved origin
                  <Input
                    id={`${fieldId}-origin`}
                    value={origin}
                    onChange={(event) => setOrigin(event.target.value)}
                    maxLength={256}
                    placeholder="https://prism.example.com"
                    disabled={busy}
                    required
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </label>
              </div>
              <label className="block space-y-1.5 text-xs font-medium" htmlFor={`${fieldId}-key`}>
                Public verification key
                <Input
                  id={`${fieldId}-key`}
                  value={publicKey}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (/PRIVATE KEY/.test(value)) {
                      setError(
                        "Use the public verification key. Keep the private key on the host.",
                      );
                      return;
                    }
                    setPublicKey(value);
                  }}
                  placeholder="Base64url Ed25519 public key"
                  disabled={busy}
                  required
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </label>
              <Button
                type="submit"
                size="sm"
                disabled={busy || !label.trim() || !origin.trim() || !publicKey.trim()}
              >
                {busy ? "Preparing…" : "Create pairing challenge"}
              </Button>
            </form>
          ) : challenge ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">Prove ownership of {label}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    This challenge expires at {new Date(challenge.expiresAt).toLocaleTimeString()}.
                    Sign its exact text on the host.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => void copyChallenge()}>
                  {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                  {copied ? "Copied" : "Copy challenge"}
                </Button>
              </div>
              <textarea
                aria-label="Exact pairing challenge"
                readOnly
                value={challenge.challenge}
                rows={5}
                spellCheck={false}
                className="w-full resize-y rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-5"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                Serve the signed proof on this host before completing pairing. Paste only the
                returned signature here.
              </p>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    completeMicPrismPairing({
                      ...input,
                      challengeId: challenge.challengeId,
                      signature: signature.trim(),
                    }),
                    (instance) => {
                      setPaired(instance);
                      setChallenge(null);
                      setSignature("");
                      setNotice(
                        "Host paired. Select it below when you are ready to change the shared connection.",
                      );
                    },
                  );
                }}
              >
                <label
                  className="block space-y-1.5 text-xs font-medium"
                  htmlFor={`${fieldId}-signature`}
                >
                  Host signature
                  <Input
                    id={`${fieldId}-signature`}
                    value={signature}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (/PRIVATE KEY/.test(value)) {
                        setError("Paste only the host signature, never a private key.");
                        return;
                      }
                      setSignature(value);
                    }}
                    placeholder="Base64url signature"
                    disabled={busy}
                    required
                    autoCapitalize="none"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={busy || !signature.trim()}>
                    {busy ? "Verifying host…" : "Verify and pair"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setChallenge(null);
                      setSignature("");
                      setError(null);
                    }}
                  >
                    Start again
                  </Button>
                </div>
              </form>
            </div>
          ) : paired ? (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">{label} is paired</h3>
              <p className="text-sm leading-6 text-muted-foreground">
                Selecting this host changes Prism for everyone using the shared pool. Current
                streams on a previously selected host will lose access. The current selection is{" "}
                {service?.label ?? "no host"}.
              </p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    selectMicPrismInstance({
                      ...input,
                      serviceInstanceId: paired.serviceInstanceId,
                      expectedSelectionRevision: access.discovery.selectionRevision,
                    }),
                    () => {
                      setPaired(null);
                      setExpanded(false);
                      setNotice("Shared Prism host updated.");
                      onChanged();
                    },
                  )
                }
              >
                <LinkIcon className="size-3.5" />
                {busy ? "Selecting…" : "Use this host for Prism"}
              </Button>
            </div>
          ) : null}
          <p className="flex items-start gap-2 rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
            Pairing changes the service association. Provider account refresh ownership and failover
            fencing must be handled separately before takeover.
          </p>
        </div>
      ) : null}
      {service ? (
        <div className="border-t border-border pt-4">
          {confirmation ? (
            <div className="space-y-3">
              <p className="text-sm leading-6">
                Revoke {confirmation.label}? New requests will be rejected and active Prism streams
                will stop. Pairing and selecting a host again is required to restore access.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      revokeMicPrismInstance({
                        ...input,
                        serviceInstanceId: confirmation.id,
                        expectedPairingRevision: confirmation.pairingRevision,
                      }),
                      () => {
                        setConfirmation(null);
                        setNotice("Host access revoked.");
                        onChanged();
                      },
                    )
                  }
                >
                  {busy ? "Revoking…" : "Revoke host access"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmation(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() =>
                setConfirmation({
                  id: service.id,
                  pairingRevision: service.pairingRevision,
                  label: service.label,
                })
              }
            >
              Revoke {service.label}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
