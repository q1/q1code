import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import { getMicPrismAvailability } from "@t3tools/client-runtime/fork";
import type { MicPrismService } from "@q1code/core/micIdentity";
import type { MicPrismAvailability } from "@q1code/core/micPrismApi";
import { runtime } from "~/lib/runtime";
import { useDocumentVisible } from "../prism/prismUi";
import { micIdentityGeneration, readMicIdentityToken } from "./micIdentitySession";

/** Availability is an observation; errors preserve the last model selection and stop new requests. */
export function useMicPrismAvailability(input: {
  authorityUrl: string; service?: MicPrismService; generation: number; disabled: boolean; revision?: number;
}) {
  const visible = useDocumentVisible();
  const [state, setState] = useState<{ value: MicPrismAvailability | null; error: string | null; loading: boolean }>({ value: null, error: null, loading: true });
  useEffect(() => {
    if (!visible || input.disabled) return;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await runtime.runPromise(getMicPrismAvailability({
          baseUrl: input.authorityUrl, ...(input.service ? { expectedService: input.service } : {}), getToken: readMicIdentityToken,
          isCurrent: () => micIdentityGeneration() === input.generation,
        }).pipe(Effect.result), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setState((previous) => result._tag === "Success" ? { value: result.success, error: null, loading: false }
          : { ...previous, error: result.failure.message, loading: false });
      } catch {
        if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, error: "Model availability could not be checked. Refresh before sending a request." }));
      } finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [input.authorityUrl, input.service?.id, input.service?.pairingRevision, input.service?.apiUrl, input.service?.inferenceUrl, input.generation, input.disabled, input.revision, visible]);
  return state;
}
