import { useEffect, useRef, useState } from "react";
import { ArrowUpIcon, SquareIcon, RefreshCwIcon } from "lucide-react";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describeMicPrismAvailability, describeMicPrismWarning, streamMicPrismChat } from "@t3tools/client-runtime/fork";
import type { MicPrismService } from "@q1code/core/micIdentity";
import { Button } from "~/components/ui/button";
import { runtime } from "~/lib/runtime";
import { micIdentityGeneration, readMicIdentityToken } from "./micIdentitySession";
import { useMicPrismAvailability } from "./useMicPrismAvailability";

/** A service-only conversation; no environment, files or provider credentials are required. */
export function MicPrismChat({
  authorityUrl,
  service,
  generation,
  disabled,
}: {
  authorityUrl: string;
  service: MicPrismService;
  generation: number;
  disabled: boolean;
}) {
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  const input = () => ({
    baseUrl: authorityUrl,
    expectedService: service,
    getToken: readMicIdentityToken,
    isCurrent: () => micIdentityGeneration() === generation,
  });

  const availability = useMicPrismAvailability({ authorityUrl, service, generation, disabled, revision });
  const models = availability.value?.models ?? [];
  const loading = availability.loading;
  const selected = models.find((entry) => entry.id === model);
  const canSend = selected?.available === true && availability.error === null;
  useEffect(() => {
    if (availability.value) setModel((selected) => selected || availability.value!.models.find((entry) => entry.available)?.id || availability.value!.models[0]?.id || "");
  }, [availability.value]);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (disabled) active.current?.abort();
  }, [disabled]);

  const send = async () => {
    if (disabled || loading || active.current || !canSend || !prompt.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setAnswer("");
    setError(null);
    try {
      const result = await runtime.runPromise(
        streamMicPrismChat({
          ...input(),
          model,
          messages: [{ role: "user", content: prompt.trim() }],
        }).pipe(
          Stream.runForEach((text) =>
            Effect.sync(() => {
              if (!controller.signal.aborted && micIdentityGeneration() === generation)
                setAnswer((value) => value + text);
            }),
          ),
          Effect.result,
        ),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted && result._tag === "Failure") setError(result.failure.message);
    } catch {
      if (!controller.signal.aborted) setError("The response was interrupted. Please try again.");
    } finally {
      if (active.current === controller) {
        active.current = null;
        setRunning(false);
      }
    }
  };

  return (
    <section
      aria-labelledby="prism-chat-title"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 id="prism-chat-title" className="text-sm font-medium">
            Try a model
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            A one-off prompt, not saved in q1code.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Prism model"
            value={model}
            disabled={disabled || loading || running}
            onChange={(event) => setModel(event.target.value)}
            className="max-w-64 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            {!model ? (
              <option value="">{loading ? "Loading models…" : "No models listed"}</option>
            ) : null}
            {model && !selected ? (
              <option value={model}>{model} — unavailable</option>
            ) : null}
            {models.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.available}>
                {entry.id}{entry.available ? "" : " — unavailable"}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh models"
            disabled={disabled || running || loading}
            onClick={() => {
              setRevision((n) => n + 1);
            }}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </div>
      <div className="space-y-4 p-5">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {availability.error ?? (selected ? describeMicPrismAvailability(selected) : "Choose a configured model. Prism checks eligibility for each request.")}
        </p>
        {selected?.warnings.map((warning) => <p key={warning} className="text-xs text-muted-foreground">{describeMicPrismWarning(warning)}</p>)}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="space-y-3"
        >
          <label htmlFor="prism-prompt" className="sr-only">
            Message to Prism
          </label>
          <textarea
            id="prism-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={disabled || running}
            maxLength={131072}
            rows={3}
            placeholder="Ask something to check your connection…"
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">Uses Prism inference access only.</span>
            {running ? (
              <Button
                key="stop"
                type="button"
                variant="outline"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  active.current?.abort();
                  setError("Response stopped.");
                }}
              >
                <SquareIcon className="size-3" />
                Stop
              </Button>
            ) : (
              <Button
                key="send"
                type="submit"
                disabled={disabled || loading || !canSend || !prompt.trim()}
              >
                <ArrowUpIcon className="size-4" />
                Send
              </Button>
            )}
          </div>
        </form>
        {answer || running ? (
          <div
            role="region"
            aria-label="Prism response"
            aria-busy={running}
            className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 text-sm leading-6"
          >
            {answer || "Waiting for Prism…"}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
