/** Small pieces the Prism sections share: state badge, copy button, error toast, visibility hook. */
import type { PrismAccount, PrismState } from "@q1code/core/prismApi";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useRef, useSyncExternalStore } from "react";

import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "~/components/ui/anchoredCopyToast";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { ensureLocalApi } from "~/localApi";

import { PRISM_STATE_LABELS, labelPrismProvider } from "./prismAccountsState";
import { type PrismCallError, describePrismCallError } from "./usePrismApi";

const STATE_BADGE_VARIANT: Readonly<
  Record<PrismState, "outline" | "warning" | "success" | "error">
> = {
  off: "outline",
  starting: "warning",
  ready: "success",
  failed: "error",
};

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Polling gates on this so a background tab costs nothing. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );
}

export function reportPrismError(title: string, error: PrismCallError) {
  toastManager.add(
    stackedThreadToast({ type: "error", title, description: describePrismCallError(error) }),
  );
}

export function openExternalUrl(url: string) {
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open the sign-in page",
          description: error instanceof Error ? error.message : "Copy the link instead.",
        }),
      );
    });
}

export function describePrismAccount(account: PrismAccount): string {
  const name = account.email ?? account.label;
  return `${labelPrismProvider(account.provider)} account ${name}`;
}

export function PrismStateBadge({ state }: { readonly state: PrismState }) {
  return <Badge variant={STATE_BADGE_VARIANT[state]}>{PRISM_STATE_LABELS[state]}</Badge>;
}

/** Read-only value in a settings row's control slot. */
export function MonoValue({
  children,
  muted = false,
  className,
}: {
  readonly children: ReactNode;
  readonly muted?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "min-w-0 truncate font-mono text-xs",
        muted ? "text-muted-foreground" : "text-foreground/90",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function CopyValueButton({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  return (
    <Button
      ref={ref}
      size="icon-micro"
      variant="ghost-muted"
      aria-label={label}
      onClick={() => copyToClipboard(value, undefined)}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
}
