import { App, Notice, TFile, Vault } from "obsidian";
import * as Y from "yjs";

import { encodeFrame, MSG_SYNC_STEP1, MSG_SYNC_STEP2, MSG_UPDATE } from "./protocol";
import { NoteIndex, SyncStore } from "./persist";

export interface Conn {
  send: (frame: Uint8Array) => void;
}

interface DocEntry {
  doc: Y.Doc;
  text: Y.Text;
  meta: Y.Map<unknown>;
  lastContent: string;
  lastPath: string;
}

export function isSyncablePath(path: string): boolean {
  return path.endsWith(".md");
}

const PERSIST_DEBOUNCE_MS = 3000;

export class NoteSyncManager {
  private index: Record<string, NoteIndex> = {};
  private docs = new Map<string, DocEntry>();
  private svCache = new Map<string, Uint8Array>();
  private applyingRemoteByPath = new Set<string>();
  private conn: Conn | null = null;
  private suspended = false;
  private applySerial: Promise<void> = Promise.resolve();
  private persistTimers = new Map<string, number>();
  private indexTimer: number | null = null;

  constructor(
    private app: App,
    private vault: Vault,
    private store: SyncStore
  ) {}

  async init(showProgress = false) {
    await this.store.ensureDir();
    this.index = await this.store.readIndex();

    const noteIds = Object.keys(this.index);
    let j = 0;
    for (const id of noteIds) {
      if (!this.index[id].deleted) {
        const sv = await this.store.readSv(id);
        if (sv) this.svCache.set(id, sv);
      }
      if (++j % 20 === 0) await sleep0();
    }

    const files = this.vault.getMarkdownFiles().filter((f) => isSyncablePath(f.path));
    let i = 0;
    for (const file of files) {
      let noteId = this.findNoteIdByPath(file.path);
      if (!noteId) {
        noteId = crypto.randomUUID();
        this.index[noteId] = { path: file.path, deleted: false, mtime: 0 };
      }
      const idx = this.index[noteId];
      if (idx.mtime !== file.stat.mtime) {
        await this.ensureDoc(noteId, file.path);
        const entry = this.docs.get(noteId);
        if (entry) {
          const content = await this.vault.read(file);
          if (content !== entry.lastContent) {
            const d = diffText(entry.lastContent, content);
            entry.doc.transact(() => {
              if (d.del > 0) entry.text.delete(d.retain, d.del);
              if (d.ins.length > 0) entry.text.insert(d.retain, d.ins);
              entry.meta.set("path", file.path);
              entry.meta.set("deleted", false);
            });
            entry.lastContent = content;
          }
          idx.mtime = file.stat.mtime;
        }
      }
      i++;
      if (showProgress && i % 25 === 0) {
        new Notice(`Cloud Relay: memindai ${i}/${files.length}…`);
      }
      if (i % 10 === 0) await sleep0();
    }
    this.scheduleIndexWrite();
  }

  setConn(conn: Conn | null) {
    this.conn = conn;
  }

  suspend() {
    this.suspended = true;
  }

  async reset() {
    for (const t of this.persistTimers.values()) window.clearTimeout(t);
    this.persistTimers.clear();
    if (this.indexTimer !== null) window.clearTimeout(this.indexTimer);
    this.indexTimer = null;
    this.index = {};
    this.docs.clear();
    this.svCache.clear();
    this.applyingRemoteByPath.clear();
    await this.store.archive();
    await this.store.ensureDir();
    await this.store.writeIndex(this.index);
    this.suspended = false;
  }

  async flush() {
    for (const t of this.persistTimers.keys()) {
      await this.persistNow(t);
    }
  }

  async sendSyncSteps(conn: Conn) {
    const ids = Object.keys(this.index).filter((id) => !this.index[id].deleted);
    for (const id of ids) {
      let sv = this.svCache.get(id);
      if (!sv) {
        await this.ensureDoc(id, this.index[id].path);
        const entry = this.docs.get(id);
        if (entry) {
          sv = new Uint8Array(Y.encodeStateVector(entry.doc));
          this.svCache.set(id, sv);
        }
      }
      if (sv && sv.length > 0 && conn) {
        conn.send(encodeFrame(MSG_SYNC_STEP1, id, sv));
      }
    }
  }

  async onDocList(noteIds: string[]) {
    for (const id of noteIds) {
      if (!this.index[id]) this.index[id] = { path: "", deleted: false };
      let sv = this.svCache.get(id);
      if (!sv) {
        await this.ensureDoc(id, this.index[id].path);
        const entry = this.docs.get(id);
        sv = entry ? new Uint8Array(Y.encodeStateVector(entry.doc)) : new Uint8Array(0);
        this.svCache.set(id, sv);
      }
      if (this.conn) {
        this.conn.send(encodeFrame(MSG_SYNC_STEP1, id, sv));
      }
    }
    this.scheduleIndexWrite();
  }

  onSyncStep1(noteId: string, sv: Uint8Array) {
    void (async () => {
      await this.ensureDoc(noteId, this.index[noteId]?.path ?? "");
      const entry = this.docs.get(noteId);
      if (!entry || !this.conn) return;
      const diff = Y.encodeStateAsUpdate(entry.doc, sv);
      this.conn.send(encodeFrame(MSG_SYNC_STEP2, noteId, diff));
    })();
  }

  onSyncStep2(noteId: string, update: Uint8Array) {
    this.queueApply(noteId, update);
  }

  onUpdate(noteId: string, update: Uint8Array) {
    this.queueApply(noteId, update);
  }

  private queueApply(noteId: string, update: Uint8Array) {
    this.applySerial = this.applySerial
      .then(() => this.applyRemote(noteId, update))
      .catch((e) => console.error("cloud-relay apply gagal:", e));
  }

  onFileModify(file: TFile, content: string) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    if (this.applyingRemoteByPath.has(file.path)) return;
    let noteId = this.findNoteIdByPath(file.path);
    if (!noteId) {
      noteId = crypto.randomUUID();
      this.index[noteId] = { path: file.path, deleted: false, mtime: 0 };
    }
    const id = noteId;
    this.index[id].mtime = file.stat.mtime;
    this.scheduleIndexWrite();
    void (async () => {
      await this.ensureDoc(id, file.path);
      const entry = this.docs.get(id);
      if (!entry || content === entry.lastContent) return;
      const d = diffText(entry.lastContent, content);
      entry.doc.transact(() => {
        if (d.del > 0) entry.text.delete(d.retain, d.del);
        if (d.ins.length > 0) entry.text.insert(d.retain, d.ins);
        entry.meta.set("path", file.path);
        entry.meta.set("deleted", false);
      });
      entry.lastContent = content;
      entry.lastPath = file.path;
    })();
  }

  onFileCreate(file: TFile, content: string) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    this.onFileModify(file, content);
  }

  onFileDelete(file: TFile) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    const path = file.path;
    if (this.applyingRemoteByPath.has(path)) return;
    const noteId = this.findNoteIdByPath(path);
    if (!noteId) return;
    this.index[noteId].deleted = true;
    this.scheduleIndexWrite();
    void (async () => {
      await this.ensureDoc(noteId, path);
      const entry = this.docs.get(noteId);
      if (!entry) return;
      entry.doc.transact(() => {
        entry.meta.set("deleted", true);
      });
    })();
  }

  onFileRename(file: TFile, oldPath: string) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    if (
      this.applyingRemoteByPath.has(oldPath) ||
      this.applyingRemoteByPath.has(file.path)
    )
      return;
    const noteId = this.findNoteIdByPath(oldPath);
    if (!noteId) return;
    this.index[noteId].path = file.path;
    this.index[noteId].mtime = file.stat.mtime;
    this.scheduleIndexWrite();
    void (async () => {
      await this.ensureDoc(noteId, oldPath);
      const entry = this.docs.get(noteId);
      if (!entry) return;
      entry.doc.transact(() => {
        entry.meta.set("path", file.path);
      });
      entry.lastPath = file.path;
    })();
  }

  private async applyRemote(noteId: string, update: Uint8Array) {
    if (this.suspended) return;
    await sleep0();
    await this.ensureDoc(noteId, this.index[noteId]?.path ?? "");
    const entry = this.docs.get(noteId);
    if (!entry) return;
    const oldContent = entry.text.toString();
    entry.doc.transact(() => {
      Y.applyUpdate(entry.doc, update);
    }, "remote");
    const newContent = entry.text.toString();
    const newPath = (entry.meta.get("path") as string | undefined) ?? "";
    const deleted = (entry.meta.get("deleted") as boolean | undefined) ?? false;

    const idx = this.index[noteId];
    const existingPath = idx?.path ?? "";

    if (deleted) {
      if (existingPath) {
        const file = this.vault.getAbstractFileByPath(existingPath);
        if (file instanceof TFile) {
          this.applyingRemoteByPath.add(existingPath);
          await this.vault.delete(file);
          this.applyingRemoteByPath.delete(existingPath);
        }
      }
      if (idx) idx.deleted = true;
      this.scheduleIndexWrite();
      entry.lastContent = "";
      entry.lastPath = existingPath;
      this.persistDoc(noteId);
      return;
    }

    if (!idx || idx.deleted || !existingPath) {
      let finalPath = newPath;
      if (finalPath && this.vault.getAbstractFileByPath(finalPath) instanceof TFile) {
        finalPath = finalPath.replace(/(\.md)$/i, " (konflik dari device lain)$1");
        entry.doc.transact(() => {
          entry.meta.set("path", finalPath);
        });
      }
      if (finalPath) {
        await this.ensureParentFolders(finalPath);
        this.applyingRemoteByPath.add(finalPath);
        await this.vault.create(finalPath, newContent);
        this.applyingRemoteByPath.delete(finalPath);
        this.index[noteId] = { path: finalPath, deleted: false };
      }
      this.scheduleIndexWrite();
      entry.lastContent = newContent;
      entry.lastPath = finalPath;
      this.persistDoc(noteId);
      return;
    }

    if (existingPath !== newPath && newPath) {
      const file = this.vault.getAbstractFileByPath(existingPath);
      if (file instanceof TFile) {
        await this.ensureParentFolders(newPath);
        this.applyingRemoteByPath.add(newPath);
        await this.vault.rename(file, newPath);
        this.applyingRemoteByPath.delete(newPath);
      }
      idx.path = newPath;
      this.scheduleIndexWrite();
      entry.lastContent = newContent;
      entry.lastPath = newPath;
      this.persistDoc(noteId);
      return;
    }

    if (newContent !== oldContent) {
      const file = this.vault.getAbstractFileByPath(existingPath);
      if (file instanceof TFile) {
        this.applyingRemoteByPath.add(existingPath);
        await this.vault.modify(file, newContent);
        this.applyingRemoteByPath.delete(existingPath);
        idx.mtime = file.stat.mtime;
        this.scheduleIndexWrite();
      }
    }
    entry.lastContent = newContent;
    entry.lastPath = existingPath;
    this.persistDoc(noteId);
  }

  private async ensureDoc(noteId: string, path: string) {
    if (this.docs.has(noteId)) return;
    const doc = new Y.Doc();
    const blob = await this.store.readBlob(noteId);
    if (blob) {
      try {
        Y.applyUpdate(doc, blob);
      } catch (e) {
        console.error("cloud-relay: blob rusak, abaikan", noteId, e);
      }
    }
    const text = doc.getText("content");
    const meta = doc.getMap<unknown>("meta");
    if (path && !meta.get("path")) {
      doc.transact(() => {
        meta.set("path", path);
        meta.set("deleted", false);
      }, "init");
    }
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") {
        this.conn?.send(encodeFrame(MSG_UPDATE, noteId, new Uint8Array(update)));
      }
      this.persistDoc(noteId);
    });
    const entry: DocEntry = {
      doc,
      text,
      meta,
      lastContent: text.toString(),
      lastPath: path,
    };
    this.docs.set(noteId, entry);
    this.svCache.set(noteId, new Uint8Array(Y.encodeStateVector(doc)));
  }

  private persistDoc(noteId: string) {
    const prev = this.persistTimers.get(noteId);
    if (prev !== undefined) window.clearTimeout(prev);
    const t = window.setTimeout(() => {
      void this.persistNow(noteId);
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimers.set(noteId, t);
  }

  private async persistNow(noteId: string) {
    this.persistTimers.delete(noteId);
    const entry = this.docs.get(noteId);
    if (!entry) return;
    const blob = Y.encodeStateAsUpdate(entry.doc);
    const sv = new Uint8Array(Y.encodeStateVector(entry.doc));
    this.svCache.set(noteId, sv);
    try {
      await this.store.writeBlob(noteId, blob, sv);
    } catch (e) {
      console.error("cloud-relay: gagal tulis blob", noteId, e);
    }
  }

  private scheduleIndexWrite() {
    if (this.indexTimer !== null) window.clearTimeout(this.indexTimer);
    this.indexTimer = window.setTimeout(() => {
      this.indexTimer = null;
      void this.store.writeIndex(this.index);
    }, PERSIST_DEBOUNCE_MS);
  }

  diagnostic(): { localNoteIds: string[]; pathById: Record<string, string> } {
    const localNoteIds: string[] = [];
    const pathById: Record<string, string> = {};
    for (const [id, idx] of Object.entries(this.index)) {
      if (!idx.deleted) {
        localNoteIds.push(id);
        pathById[id] = idx.path;
      }
    }
    return { localNoteIds, pathById };
  }

  private findNoteIdByPath(path: string): string | null {
    for (const [id, entry] of Object.entries(this.index)) {
      if (entry.path === path && !entry.deleted) return id;
    }
    return null;
  }

  private async ensureParentFolders(path: string) {
    const parent = path.split("/").slice(0, -1).filter(Boolean);
    if (parent.length === 0) return;
    let cur = "";
    for (const part of parent) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(cur))) {
        await this.app.vault.createFolder(cur);
      }
    }
  }
}

function sleep0() {
  return new Promise((r) => setTimeout(r, 0));
}

function diffText(oldS: string, newS: string): {
  retain: number;
  del: number;
  ins: string;
} {
  let s = 0;
  const min = Math.min(oldS.length, newS.length);
  while (s < min && oldS[s] === newS[s]) s++;
  let o = oldS.length;
  let n = newS.length;
  while (o > s && n > s && oldS[o - 1] === newS[n - 1]) {
    o--;
    n--;
  }
  return { retain: s, del: o - s, ins: newS.slice(s, n) };
}
