// A retiring identity controller must finish its DELETE before a replacement sends PUT.
const lanes = new Map<string, Promise<void>>();

export function enqueueMicPrismThreadOperation(
  key: string,
  operation: () => Promise<void>,
): Promise<void> {
  const queued = (lanes.get(key) ?? Promise.resolve()).then(operation, operation);
  const settled = queued.catch(() => {});
  lanes.set(key, settled);
  void settled.finally(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return queued;
}

export const pendingMicPrismThreadOperation = (key: string): Promise<void> =>
  lanes.get(key) ?? Promise.resolve();
