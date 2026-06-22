import type { RunState } from "./model";

export type RunStateSnapshot =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: RunState; error: null }
  | { status: "error"; data: RunState | null; error: string };

type Listener = () => void;

export function createRunStateStore({ sandboxId, token }: { sandboxId: string; token: string }) {
  let snapshot: RunStateSnapshot = { status: "loading", data: null, error: null };
  let listeners = new Set<Listener>();
  let interval: ReturnType<typeof setInterval> | null = null;
  let inFlight: AbortController | null = null;

  const statusUrl = `/demo/status?sandboxId=${encodeURIComponent(sandboxId)}&token=${encodeURIComponent(token)}`;

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setSnapshot = (next: RunStateSnapshot) => {
    snapshot = next;
    emit();
  };

  const poll = async () => {
    if (inFlight) {
      return;
    }
    const controller = new AbortController();
    inFlight = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(statusUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      const data = await response.json() as RunState;
      setSnapshot({ status: "ready", data, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Status request failed for an unknown reason.";
      setSnapshot({ status: "error", data: snapshot.data, error: message });
    } finally {
      clearTimeout(timeout);
      inFlight = null;
    }
  };

  const start = () => {
    if (interval) {
      return;
    }
    void poll();
    interval = setInterval(() => void poll(), 2_000);
  };

  const stop = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    inFlight?.abort();
    inFlight = null;
  };

  return {
    getSnapshot: () => snapshot,
    getStatusUrl: () => statusUrl,
    subscribe(listener: Listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
        }
      };
    },
  };
}

async function responseError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string") {
      return body.error;
    }
  }
  return await response.text();
}
