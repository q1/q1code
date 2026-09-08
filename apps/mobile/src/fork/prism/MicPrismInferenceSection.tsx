import {
  completeMicPrismChat,
  getMicPrismAvailability,
  describeMicPrismAvailability,
  describeMicPrismWarning,
} from "@t3tools/client-runtime/fork";
import type { MicPrismModelAvailability } from "@q1code/core/micPrismApi";
import type { MicIdentityClientInput } from "@t3tools/client-runtime/fork";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { runtime } from "../../lib/runtime";

/** A small inference surface; these service grants never start an environment coding agent. */
export function MicPrismInferenceSection(props: {
  readonly input: MicIdentityClientInput;
  readonly enabled: boolean;
}) {
  const [models, setModels] = useState<ReadonlyArray<MicPrismModelAvailability>>([]);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const currentInput = useRef<MicIdentityClientInput | null>(props.input);
  useLayoutEffect(() => {
    currentInput.current = props.input;
    return () => {
      currentInput.current = null;
      request.current?.abort();
    };
  }, [props.input]);

  const loadModels = useCallback(() => {
    catalogRequest.current?.abort();
    const abort = new AbortController();
    catalogRequest.current = abort;
    void runtime
      .runPromise(getMicPrismAvailability(props.input).pipe(Effect.result), {
        signal: abort.signal,
      })
      .then((result) => {
        if (
          abort.signal.aborted ||
          currentInput.current !== props.input ||
          props.input.isCurrent?.() === false
        )
          return;
        if (result._tag === "Success") {
          setModels(result.success.models);
          setAvailabilityError(null);
          setModel(
            (previous) =>
              previous ||
              result.success.models.find((entry) => entry.available)?.id ||
              result.success.models[0]?.id ||
              "",
          );
        } else {
          setAvailabilityError("Could not check model availability. Refresh access and try again.");
        }
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setAvailabilityError("Could not check model availability. Try again.");
      });
    return abort;
  }, [props.input]);
  useEffect(() => {
    const abort = loadModels();
    return () => {
      abort.abort();
      catalogRequest.current?.abort();
    };
  }, [loadModels]);

  const selected = models.find((entry) => entry.id === model);
  const canSend = selected?.available === true && availabilityError === null;

  const send = async () => {
    if (!props.enabled || request.current || !canSend || !prompt.trim()) return;
    const input = props.input;
    const abort = new AbortController();
    request.current = abort;
    setBusy(true);
    setResponse("");
    setError(null);
    try {
      const result = await runtime.runPromise(
        completeMicPrismChat({
          ...input,
          model,
          messages: [{ role: "user", content: prompt.trim() }],
        }).pipe(Effect.result),
        { signal: abort.signal },
      );
      if (abort.signal.aborted || currentInput.current !== input || input.isCurrent?.() === false)
        return;
      if (result._tag === "Success") setResponse(result.success);
      else {
        if (
          result.failure._tag === "MicIdentityUnauthorizedError" ||
          result.failure._tag === "MicIdentityForbiddenError"
        ) {
          setModels([]);
          setModel("");
          setResponse("");
          setError("Prism access was denied. Refresh your mic.sc sign-in to continue.");
        } else
          setError(
            "Prism could not complete this request. Check model availability and try again.",
          );
      }
    } catch {
      if (!abort.signal.aborted) setError("The request did not complete. Try again.");
    } finally {
      if (request.current === abort) {
        request.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <SettingsSection title="Try a model">
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          {availabilityError ??
            (selected
              ? describeMicPrismAvailability(selected)
              : "Choose a configured model. Prism verifies eligibility on every request.")}
        </Text>
        {selected?.warnings.map((warning) => (
          <Text key={warning} className="text-xs text-foreground-muted">
            {describeMicPrismWarning(warning)}
          </Text>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose Prism model"
          disabled={!props.enabled || busy || models.length === 0}
          onPress={() => setModelPickerOpen(true)}
          className="rounded-xl bg-subtle px-4 py-3"
        >
          <Text className="text-sm text-foreground">{model || "Models unavailable"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!props.enabled || busy}
          onPress={() => {
            loadModels();
          }}
          className="self-start rounded-full bg-subtle px-4 py-2"
        >
          <Text className="text-sm text-foreground">Refresh models</Text>
        </Pressable>
        <TextInput
          accessibilityLabel="Prompt for Prism"
          placeholder="Ask a question…"
          multiline
          maxLength={8000}
          value={prompt}
          onChangeText={setPrompt}
          editable={props.enabled && !busy}
          className="min-h-24 rounded-xl bg-subtle p-3 text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !busy && (!props.enabled || !canSend || !prompt.trim()) }}
          disabled={!busy && (!props.enabled || !canSend || !prompt.trim())}
          onPress={() => {
            if (busy) {
              request.current?.abort();
              setError("Request cancelled.");
            } else void send();
          }}
          className="self-start rounded-full bg-subtle px-4 py-2"
        >
          <Text className="text-sm text-foreground">
            {busy ? "Cancel request" : "Send to Prism"}
          </Text>
        </Pressable>
        {busy ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            Waiting for a response…
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" className="text-sm text-adaptive-rose-700-300">
            {error}
          </Text>
        ) : null}
        {response ? (
          <Text selectable className="text-sm leading-relaxed text-foreground">
            {response}
          </Text>
        ) : null}
      </View>
      <Modal
        visible={modelPickerOpen}
        animationType="slide"
        onRequestClose={() => setModelPickerOpen(false)}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-sheet"
          contentContainerClassName="gap-2 p-5"
        >
          <Text className="text-lg font-t3-medium text-foreground">Choose a model</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => setModelPickerOpen(false)}
            className="self-start rounded-full bg-subtle px-4 py-2"
          >
            <Text className="text-foreground">Done</Text>
          </Pressable>
          {models.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: entry.id === model, disabled: !entry.available }}
              disabled={!entry.available}
              onPress={() => {
                setModel(entry.id);
                setModelPickerOpen(false);
              }}
              className="rounded-xl bg-subtle p-4"
            >
              <Text className="text-foreground">
                {entry.id === model ? "✓ " : ""}
                {entry.id}
                {entry.available ? "" : " — unavailable"}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </Modal>
    </SettingsSection>
  );
}
