import path from "node:path";
import {
  appendJsonl,
  ensureDir,
  listDirs,
  readJson,
  readJsonl,
  removeDir,
  writeJsonAtomic,
  writeJsonl,
  writeJsonlAtomic,
} from "../../util/fs.js";
import { sessionsDir } from "../../util/paths.js";
import { newSessionId } from "../../util/id.js";
import type { Message, Session, SessionMeta } from "./types.js";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface CreateSessionInput {
  model: string;
  provider?: string;
  cwd: string;
  title?: string;
}

/**
 * File layout:
 *   ~/.tinytcode/sessions/<id>/meta.json
 *   ~/.tinytcode/sessions/<id>/messages.jsonl
 *
 * JSONL is appended as messages complete, so a crash loses at most the
 * message that was being generated. In-turn compaction checkpoints rewrite
 * the complete raw history atomically before advancing the memory cursor.
 */
export class SessionStore {
  constructor(private readonly root: string = sessionsDir()) {}

  private dir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(this.root, id);
  }

  private metaPath(id: string): string {
    return path.join(this.dir(id), "meta.json");
  }

  private messagesPath(id: string): string {
    return path.join(this.dir(id), "messages.jsonl");
  }

  async list(): Promise<SessionMeta[]> {
    const ids = await listDirs(this.root);
    const metas: SessionMeta[] = [];
    for (const id of ids) {
      try {
        const meta = await readJson<SessionMeta>(path.join(this.root, id, "meta.json"));
        if (meta) metas.push(meta);
      } catch {
        // Skip unreadable/broken sessions instead of failing the whole list.
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const id = newSessionId();
    const now = Date.now();
    const meta: SessionMeta = {
      id,
      title: input.title ?? "New session",
      model: input.model,
      ...(input.provider ? { provider: input.provider } : {}),
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    await ensureDir(this.dir(id));
    await writeJsonAtomic(this.metaPath(id), meta);
    await writeJsonl(this.messagesPath(id), []);
    return { meta, messages: [] };
  }

  async load(id: string): Promise<Session> {
    const meta = await readJson<SessionMeta>(this.metaPath(id));
    if (!meta) throw new Error(`Session not found: ${id}`);
    const messages = await readJsonl<Message>(this.messagesPath(id));
    return { meta, messages };
  }

  async saveMeta(meta: SessionMeta): Promise<void> {
    await writeJsonAtomic(this.metaPath(meta.id), meta);
  }

  async appendMessage(id: string, message: Message): Promise<void> {
    await ensureDir(this.dir(id));
    await appendJsonl(this.messagesPath(id), message);
  }

  async rewriteMessages(id: string, messages: Message[]): Promise<void> {
    await writeJsonlAtomic(this.messagesPath(id), messages);
  }

  async delete(id: string): Promise<void> {
    await removeDir(this.dir(id));
  }
}
