import type { MicIdentityAccess } from "@q1code/core/micIdentityApi";
import {
  createMicPrismPairingController,
  type MicPrismPairingClientInput,
} from "@t3tools/client-runtime/fork";
import * as Clipboard from "expo-clipboard";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { runtime } from "../../lib/runtime";

export function MicPrismPairingSection(props: {
  readonly input: MicPrismPairingClientInput;
  readonly access: MicIdentityAccess;
  readonly onChanged: () => void;
}) {
  if (!props.access.session.permissions.includes("prism:instances:manage")) return null;
  return (
    <PairingForm
      key={`${props.input.baseUrl}:${props.access.session.subject}:${props.access.session.sessionId ?? ""}`}
      {...props}
    />
  );
}

/** The host keeps its signing key. Mobile only transports public challenge/proof material. */
function PairingForm({ input, access, onChanged }: Parameters<typeof MicPrismPairingSection>[0]) {
  const [expanded, setExpanded] = useState(false);
  const [label, setLabel] = useState("");
  const [origin, setOrigin] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [signature, setSignature] = useState("");
  const [copied, setCopied] = useState(false);
  const [selection, setSelection] = useState<number | null>(null);
  const current = useRef({ input, onChanged });
  useLayoutEffect(() => {
    current.current = { input, onChanged };
  }, [input, onChanged]);
  const [controller] = useState(() =>
    createMicPrismPairingController({
      input: {
        baseUrl: input.baseUrl,
        getToken: () => current.current.input.getToken(),
        isCurrent: () => current.current.input.isCurrent(),
      },
      access,
      run: (effect, signal) => runtime.runPromise(effect, { signal }),
      onChanged: () => current.current.onChanged(),
    }),
  );
  useLayoutEffect(() => {
    controller.updateAccess(access);
  }, [access, controller]);
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { challenge, paired, confirmation, busy, error, notice } = state;
  const service = access.discovery.service;
  const reset = () => {
    controller.resetPairing();
    setSignature("");
    setCopied(false);
    setSelection(null);
  };
  const publicText = (value: string, accept: (value: string) => void) => {
    if (/PRIVATE KEY/.test(value)) {
      controller.setError("Keep private keys on the host. Paste only the public key or signature.");
      return;
    }
    accept(value);
  };
  const copyChallenge = async () => {
    if (!challenge) return;
    try {
      const written = await Clipboard.setStringAsync(challenge.challenge);
      if (controller.getSnapshot().challenge !== challenge || !input.isCurrent()) return;
      if (written) setCopied(true);
      else controller.setError("Copy is unavailable. Select and copy the full challenge below.");
    } catch {
      if (input.isCurrent())
        controller.setError("Copy is unavailable. Select and copy the full challenge below.");
    }
  };
  return (
    <SettingsSection title="Host administration">
      <View className="gap-4 p-4">
        <Text className="text-sm text-foreground-muted">
          Pair a host or recover the shared connection, even when the current host is offline.
        </Text>
        {error ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-adaptive-rose-700-300">
            {error}
          </Text>
        ) : null}
        {notice ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {notice}
          </Text>
        ) : null}
        {!expanded ? (
          <Action label="Pair a host" onPress={() => setExpanded(true)} disabled={busy} />
        ) : (
          <View className="gap-4">
            {!challenge && !paired ? (
              <>
                <Text className="text-sm text-foreground-muted">
                  Enter the host's approved origin and public verification key. Its private key
                  stays on the host.
                </Text>
                <Field
                  label="Host name"
                  value={label}
                  onChange={setLabel}
                  disabled={busy}
                  maxLength={80}
                  placeholder="Primary PC"
                />
                <Field
                  label="Approved origin"
                  value={origin}
                  onChange={setOrigin}
                  disabled={busy}
                  maxLength={256}
                  placeholder="https://prism.example.com"
                />
                <Field
                  label="Public verification key"
                  value={publicKey}
                  onChange={(value) => publicText(value, setPublicKey)}
                  disabled={busy}
                  maxLength={256}
                  placeholder="Base64url Ed25519 public key"
                  multiline
                />
                <Action
                  label={busy ? "Preparing…" : "Create pairing challenge"}
                  disabled={busy || !label.trim() || !origin.trim() || !publicKey.trim()}
                  onPress={() => {
                    setCopied(false);
                    void controller.start({
                      label: label.trim(),
                      origin: origin.trim(),
                      publicKey: publicKey.trim(),
                    });
                  }}
                />
              </>
            ) : challenge ? (
              <>
                <Text className="text-base font-t3-medium text-foreground">
                  Prove ownership of {label.trim()}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  Sign this exact text on the host and serve the signed proof at its approved
                  origin. It expires at {new Date(challenge.expiresAt).toLocaleTimeString()}.
                </Text>
                <Text
                  selectable
                  accessibilityLabel="Exact pairing challenge"
                  className="rounded-xl bg-subtle p-3 text-xs text-foreground"
                >
                  {challenge.challenge}
                </Text>
                <Action
                  label={copied ? "Copied" : "Copy challenge"}
                  onPress={() => void copyChallenge()}
                />
                <Field
                  label="Host signature"
                  value={signature}
                  onChange={(value) => publicText(value, setSignature)}
                  disabled={busy}
                  maxLength={256}
                  multiline
                  placeholder="Base64url signature"
                />
                <Action
                  label={busy ? "Verifying host…" : "Verify and pair"}
                  disabled={busy || !signature.trim()}
                  onPress={() => {
                    void controller.complete(signature.trim()).then((ok) => {
                      if (ok) setSignature("");
                    });
                  }}
                />
                <Action label="Start again" disabled={busy} onPress={reset} />
              </>
            ) : paired ? (
              <>
                <Text className="text-base font-t3-medium text-foreground">
                  {label.trim()} is paired
                </Text>
                <Text className="text-sm text-foreground-muted">
                  Pairing does not select the host. The shared pool currently uses{" "}
                  {service?.label ?? "no host"}.
                </Text>
                {selection === null ? (
                  <Action
                    label="Use this host for Prism"
                    disabled={busy}
                    onPress={() => setSelection(access.discovery.selectionRevision)}
                  />
                ) : (
                  <>
                    <Text className="text-sm text-foreground">
                      Switch the shared pool to {label.trim()}? This affects everyone. Streams on
                      the previous host will lose access.
                    </Text>
                    <Action
                      label={busy ? "Selecting…" : "Confirm host selection"}
                      disabled={busy}
                      onPress={() => {
                        void controller.select(selection).then((ok) => {
                          setSelection(null);
                          if (ok) setExpanded(false);
                        });
                      }}
                    />
                    <Action
                      label="Cancel selection"
                      disabled={busy}
                      onPress={() => setSelection(null)}
                    />
                  </>
                )}
                <Action label="Pair another host" disabled={busy} onPress={reset} />
              </>
            ) : null}
            <Text className="text-xs text-foreground-muted">
              Host proof preparation is required. Pairing does not transfer provider account refresh
              ownership.
            </Text>
            <Action
              label="Close pairing"
              disabled={busy}
              onPress={() => {
                reset();
                setExpanded(false);
              }}
            />
          </View>
        )}
        {confirmation ? (
          <View className="gap-3 rounded-xl bg-subtle p-4">
            <Text className="text-sm text-foreground">
              Revoke {confirmation.label}? New requests will be rejected and active streams will
              stop. Pair and select a host again to restore access.
            </Text>
            <Action
              label={busy ? "Revoking…" : "Revoke host access"}
              destructive
              disabled={busy}
              onPress={() => void controller.revoke()}
            />
            <Action label="Cancel revocation" disabled={busy} onPress={controller.cancelRevoke} />
          </View>
        ) : service ? (
          <Action
            label={`Revoke ${service.label}`}
            destructive
            disabled={busy}
            onPress={controller.prepareRevoke}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

function Action(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center self-start rounded-full bg-subtle px-4 py-3"
    >
      <Text
        className={
          props.disabled
            ? "text-sm text-foreground-muted"
            : props.destructive
              ? "text-sm text-adaptive-rose-700-300"
              : "text-sm text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly maxLength: number;
  readonly placeholder: string;
  readonly multiline?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        editable={!props.disabled}
        placeholder={props.placeholder}
        maxLength={props.maxLength}
        multiline={props.multiline}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-12 rounded-xl bg-subtle p-3 text-foreground"
      />
    </View>
  );
}
