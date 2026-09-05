import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../../features/settings/components/SettingsSection";
import { environmentSession } from "../../state/session";
import { useThreadShells } from "../../state/entities";
import { MicPrismThreadBridgeContext } from "./PersistentMicPrismIdentity";

export function MicPrismThreadSection(props: {
  readonly environmentId: EnvironmentId;
  readonly canInfer: boolean;
}) {
  const bridge = useContext(MicPrismThreadBridgeContext);
  const session = useAtomValue(environmentSession.sessionStateAtom(props.environmentId));
  const access = Option.getOrNull(AsyncResult.value(session));
  const canRead =
    session._tag !== "Failure" &&
    access?.authenticated === true &&
    access.scopes?.includes("orchestration:read");
  const canOperate = canRead && access?.scopes?.includes("orchestration:operate");
  const threads = useThreadShells().filter(
    (thread) =>
      canRead &&
      thread.environmentId === props.environmentId &&
      !thread.archivedAt &&
      (props.canInfer || bridge?.bindings.has(`${props.environmentId}/${thread.id}`)),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!bridge || (!props.canInfer && threads.length === 0)) return null;
  const thread = threads.find((thread) => thread.id === selected);
  const binding = selected ? bridge.bindings.get(`${props.environmentId}/${selected}`) : undefined;
  const change = async () => {
    if (!thread || busy || !canOperate || (!binding && !props.canInfer)) return;
    setBusy(true);
    try {
      if (binding) await bridge.disconnect(props.environmentId, thread.id);
      else await bridge.connect(props.environmentId, thread.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Coding threads">
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          Enable Prism for a thread you can already access. Access renews while this app is active
          and ends when you sign out. Choose Prism routing in the thread before sending.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy || threads.length === 0}
          onPress={() => setChoosing(true)}
          className="rounded-xl bg-subtle p-3"
        >
          <Text className="text-foreground">
            {thread?.title ?? (threads.length ? "Choose a thread" : "No accessible threads")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={
            busy || !thread || !canOperate || (!binding && (!bridge.active || !props.canInfer))
          }
          onPress={() => void change()}
          className="self-start rounded-full bg-subtle px-4 py-2"
        >
          <Text className="text-foreground">
            {busy ? "Updating…" : binding ? "Disconnect Prism" : "Enable Prism for thread"}
          </Text>
        </Pressable>
        {binding ? (
          <Text className="text-sm text-foreground-muted">
            Prism connected. Access expires {new Date(binding.expiresAt).toLocaleTimeString()}{" "}
            unless renewed.
          </Text>
        ) : null}
        {bridge.error ? (
          <Text className="text-sm text-adaptive-rose-700-300">{bridge.error}</Text>
        ) : null}
      </View>
      <Modal visible={choosing} animationType="slide" onRequestClose={() => setChoosing(false)}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1 bg-sheet"
          contentContainerClassName="gap-2 p-5"
        >
          <Text className="text-lg text-foreground">Choose a coding thread</Text>
          <Pressable accessibilityRole="button" onPress={() => setChoosing(false)} className="p-3">
            <Text className="text-foreground">Done</Text>
          </Pressable>
          {threads.map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: selected === thread.id }}
              onPress={() => {
                setSelected(thread.id);
                setChoosing(false);
              }}
              className="rounded-xl bg-subtle p-3"
            >
              <Text className="text-foreground">{thread.title}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </Modal>
    </SettingsSection>
  );
}
