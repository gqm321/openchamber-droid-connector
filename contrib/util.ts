import type { OCEvent } from "../src/types.js";

/** Minimal SSE client over fetch, collecting parsed OCEvents. */
export class SseCollector {
  private events: OCEvent[] = [];
  private waiters: Array<{ test: (e: OCEvent) => boolean; resolve: (e: OCEvent) => void; timer: NodeJS.Timeout }> = [];
  private closed = false;
  private controller = new AbortController();

  constructor(private url: string) {}

  async start(): Promise<void> {
    const res = await fetch(`${this.url}/event`, {
      signal: this.controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    void this.pump(res.body);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buf = "";
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const idx = buf.indexOf("\n\n");
          if (idx === -1) break;
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine.slice(6)) as OCEvent;
            this.events.push(ev);
            for (const w of [...this.waiters]) {
              if (w.test(ev)) {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                clearTimeout(w.timer);
                w.resolve(ev);
              }
            }
          } catch {
            /* malformed frame */
          }
        }
      }
    } catch (err) {
      if (!this.closed) console.error("  [sse] pump error:", err instanceof Error ? err.message : err);
    }
    this.closed = true;
  }

  waitFor(test: (e: OCEvent) => boolean, timeoutMs: number, label: string): Promise<OCEvent> {
    const existing = this.events.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        test,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error(`timeout waiting for ${label} after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  stop(): void {
    this.controller.abort();
  }

  get all(): OCEvent[] {
    return this.events;
  }
}

export async function api<T>(url: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}${path}`, init);
  const text = await res.text();
  let body: T;
  try {
    body = text === "" ? (undefined as T) : (JSON.parse(text) as T);
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status, body: text === "" ? undefined : body };
}

