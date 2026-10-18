import { EventEmitter } from "node:events";
import type { SessionDetail, StreamEnvelope } from "../shared/protocol.js";

type Listener = (event: StreamEnvelope) => void;

export class SessionEvents {
  private readonly sessions = new Map<string, Set<Listener>>();
  private readonly emitter = new EventEmitter();

  subscribe(sessionId: string, listener: Listener): () => void {
    let listeners = this.sessions.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.sessions.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.sessions.delete(sessionId);
    };
  }

  publish(sessionId: string, event: StreamEnvelope): void {
    for (const listener of this.sessions.get(sessionId) ?? []) listener(event);
    this.emitter.emit("event", sessionId, event);
  }

  snapshot(sessionId: string, snapshot: SessionDetail): void {
    this.publish(sessionId, { type: "snapshot", snapshot });
  }
}
