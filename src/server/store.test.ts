import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "./store.js";

describe("Store sandbox settings", () => {
  it("deletes a session and its dependents", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-store-"));
    const store = new Store(join(root, "brawl.sqlite"));
    try {
      const session = store.createSession({
        title: "Delete me",
        mode: "productive",
        sandboxMode: "disabled",
        workspace: root
      });
      store.appendEvent({
        sessionId: session.id,
        role: "user",
        type: "user_message",
        content: "remove this"
      });
      expect(store.deleteSession(session.id)).toBe(true);
      expect(store.getSession(session.id)).toBeNull();
      expect(store.events(session.id)).toEqual([]);
      expect(store.deleteSession(session.id)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("defaults new sessions to enabled and persists mode changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-store-"));
    const store = new Store(join(root, "brawl.sqlite"));
    try {
      const session = store.createSession({
        title: "Sandbox test",
        mode: "productive",
        sandboxMode: "enabled",
        workspace: root
      });
      expect(session.sandboxMode).toBe("enabled");
      const changed = store.updateSession(session.id, { sandboxMode: "disabled" });
      expect(changed.sandboxMode).toBe("disabled");
      expect(store.getSession(session.id)?.sandboxMode).toBe("disabled");
    } finally {
      store.close();
    }
  });

  it("migrates legacy sessions to enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "brawl-store-"));
    const path = join(root, "brawl.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace TEXT NOT NULL,
        active_work_order_id TEXT,
        failure TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions
      (id, title, mode, status, workspace, active_work_order_id, failure, last_seq, created_at, updated_at)
      VALUES ('legacy', 'Legacy', 'productive', 'idle', '/tmp', NULL, NULL, 0, 'now', 'now');
    `);
    legacy.close();
    const store = new Store(path);
    try {
      expect(store.getSession("legacy")?.sandboxMode).toBe("enabled");
    } finally {
      store.close();
    }
  });
});
