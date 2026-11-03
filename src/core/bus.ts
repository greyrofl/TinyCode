import type { Message, SessionMeta } from "./session/types.js";
import type { ChatStatus, NoticeLevel } from "./types.js";

export interface BusEvents {
  "message.started": { message: Message };
  "message.delta": { messageId: string; part: "text" | "reasoning"; delta: string };
  "message.updated": { messageId: string; part: Message["parts"][number] };
  "message.ended": { message: Message };
  "session.changed": { meta: SessionMeta };
  "status": ChatStatus;
  "notice": { text: string; level: NoticeLevel };
}

type Handler<T> = (event: T) => void;

/**
 * A tiny typed event bus. The core never imports the UI: every UI concern
 * (rendering, notifications) is subscribed from the outside.
 */
export class Bus {
  private readonly listeners = new Map<keyof BusEvents, Set<Handler<never>>>();

  on<K extends keyof BusEvents>(event: K, handler: Handler<BusEvents[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set?.delete(handler as Handler<never>);
    };
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<BusEvents[K]>)(payload);
      } catch {
        // A broken listener must not take down the chat loop.
      }
    }
  }
}
