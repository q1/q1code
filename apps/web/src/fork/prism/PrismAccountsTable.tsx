import type { PrismAccount } from "@q1code/core/prismApi";
import { Trash2Icon, UsersIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  type PrismAccountsState,
  describePrismAccountQuota,
  isPrismAccountPending,
  labelPrismProvider,
  parsePrismWeight,
} from "./prismAccountsState";
import { describePrismAccount } from "./prismUi";

const SKELETON_ROWS = [0, 1, 2] as const;

/** Placeholder rows while the first list is on its way. */
export function PrismAccountsSkeleton() {
  return (
    <div className="space-y-1" aria-busy aria-label="Loading accounts">
      {SKELETON_ROWS.map((row) => (
        <div key={row} className="rounded-xl px-3 py-3 sm:px-4">
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-16 rounded-full" />
            <Skeleton className="h-4 w-44 rounded-full" />
            <Skeleton className="ml-auto h-4 w-8 rounded-full" />
            <Skeleton className="h-6 w-16 rounded-md" />
            <Skeleton className="h-4 w-12 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PrismAccountsEmpty() {
  return (
    <Empty className="min-h-40 p-6 md:p-8">
      <EmptyMedia variant="icon">
        <UsersIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle className="text-base">No accounts yet</EmptyTitle>
        <EmptyDescription>
          Sign in to a provider under Add account below. Each account joins the pool the moment its
          sign-in completes.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function PrismAccountsTable({
  state,
  accounts,
  highlightedAccountId,
  onToggle,
  onWeight,
  onDelete,
}: {
  readonly state: PrismAccountsState;
  readonly accounts: ReadonlyArray<PrismAccount>;
  readonly highlightedAccountId: string | null;
  readonly onToggle: (account: PrismAccount, enabled: boolean) => void;
  readonly onWeight: (account: PrismAccount, weight: number) => void;
  readonly onDelete: (account: PrismAccount) => void;
}) {
  const showUsage = accounts.some((account) => account.usage !== undefined);
  return (
    <div className="mt-1 mb-2 -mx-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Provider</TableHead>
            <TableHead>Account</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Weight</TableHead>
            {showUsage ? <TableHead>Requests</TableHead> : null}
            <TableHead>Updated</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((account) => {
            const pending = isPrismAccountPending(state, account.id);
            const updated = formatRelativeTimeLabel(account.updatedAt);
            return (
              <TableRow
                key={account.id}
                aria-busy={pending || undefined}
                className={cn(
                  account.disabled && "text-muted-foreground",
                  pending && "opacity-64",
                  highlightedAccountId === account.id && "bg-success/8 hover:bg-success/8",
                )}
              >
                <TableCell>{labelPrismProvider(account.provider)}</TableCell>
                <TableCell className="max-w-64">
                  <span className="block truncate">{account.email ?? account.label}</span>
                  {account.email && account.email !== account.label ? (
                    <span className="block truncate text-[11px] text-muted-foreground/70">
                      {account.label}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Switch
                    size="sm"
                    checked={!account.disabled}
                    disabled={pending}
                    onCheckedChange={(checked) => onToggle(account, Boolean(checked))}
                    aria-label={`${account.disabled ? "Enable" : "Disable"} ${describePrismAccount(account)}`}
                  />
                </TableCell>
                <TableCell>
                  <WeightInput
                    account={account}
                    disabled={pending}
                    onCommit={(weight) => onWeight(account, weight)}
                  />
                </TableCell>
                {showUsage ? (
                  <TableCell
                    className="text-muted-foreground tabular-nums whitespace-nowrap"
                    title={describePrismAccountQuota(account.usage)}
                  >
                    {account.usage
                      ? `${account.usage.success} ok · ${account.usage.failed} failed`
                      : "—"}
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground">{updated || "—"}</TableCell>
                <TableCell>
                  <Button
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Remove ${describePrismAccount(account)}`}
                    disabled={pending}
                    onClick={() => onDelete(account)}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Draft while focused; the value only travels on blur or Enter, and only when it changed. */
function WeightInput({
  account,
  disabled,
  onCommit,
}: {
  readonly account: PrismAccount;
  readonly disabled: boolean;
  readonly onCommit: (weight: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs the input, and that blur must not commit the abandoned draft.
  const discardRef = useRef(false);
  const commit = () => {
    if (discardRef.current) {
      discardRef.current = false;
      return;
    }
    if (draft === null) return;
    const parsed = parsePrismWeight(draft, account.weight);
    setDraft(null);
    if (parsed !== null) onCommit(parsed);
  };
  return (
    <Input
      size="compact"
      className="w-16 text-right tabular-nums"
      inputMode="numeric"
      value={draft ?? (account.weight === undefined ? "" : String(account.weight))}
      placeholder="1"
      disabled={disabled}
      aria-label={`Weight for ${describePrismAccount(account)}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          discardRef.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
