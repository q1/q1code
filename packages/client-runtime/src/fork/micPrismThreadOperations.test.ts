import { describe, expect, it } from "@effect/vitest";
import {
  enqueueMicPrismThreadOperation,
  pendingMicPrismThreadOperation,
} from "./micPrismThreadOperations.ts";

describe("Prism thread operation ordering", () => {
  it("finishes a retired identity's cleanup before accepting its replacement", async () => {
    const events: string[] = [];
    let finish!: () => void;
    const retiring = enqueueMicPrismThreadOperation("same-environment/thread", async () => {
      events.push("old PUT");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      events.push("old DELETE");
    });
    const replacement = enqueueMicPrismThreadOperation("same-environment/thread", async () => {
      events.push("new PUT");
    });
    await Promise.resolve();
    expect(events).toEqual(["old PUT"]);
    await enqueueMicPrismThreadOperation("other-environment/thread", async () => {
      events.push("other PUT");
    });
    finish();
    await Promise.all([retiring, replacement]);
    expect(events).toEqual(["old PUT", "other PUT", "old DELETE", "new PUT"]);
  });

  it("allows reconnection after a previous operation fails", async () => {
    const failed = enqueueMicPrismThreadOperation("failed/thread", async () => {
      throw new Error("connection unavailable");
    });
    let reconnected = false;
    const next = enqueueMicPrismThreadOperation("failed/thread", async () => {
      reconnected = true;
    });
    await expect(failed).rejects.toThrow("connection unavailable");
    await next;
    await pendingMicPrismThreadOperation("failed/thread");
    expect(reconnected).toBe(true);
  });
});
