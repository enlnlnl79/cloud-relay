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

export class NoteSyncManager {
  private index: Record<string, NoteIndex> = {};
  private docs = new Map<string, DocEntry>();
  private applyingRemoteByPath = new Set<string>();
  private conn: Conn | null = null;
  private suspended = false;
  private applySerial: Promise<void> = Promise.resolve();

  private queueApply(noteId: string, update: Uint8Array) {
    this.applySerial = this.applySerial
      .then(() => this.applyRemote(noteId, update))
      .catch((e) => console.error("cloud-relay apply gagal:", e));
  }

  constructor(
    private app: App,
    private vault: Vault,
    private store: SyncStore
  ) {}

  async init(showProgress = false) {
    await this.store.ensureDir();
    this.index = await this.store.readIndex();
    const files = this.vault.getMarkdownFiles().filter((f) => isSyncablePath(f.path));
    let i = 0;
    for (const file of files) {
      let noteId = this.findNoteIdByPath(file.path);
      if (!noteId) {
        noteId = crypto.randomUUID();
        this.index[noteId] = { path: file.path, deleted: false };
      }
      await this.ensureDoc(noteId, file.path);
      const content = await this.vault.read(file);
      const entry = this.docs.get(noteId);
      if (entry && content !== entry.lastContent) {
        const d = diffText(entry.lastContent, content);
        entry.doc.transact(() => {
          if (d.del > 0) entry.text.delete(d.retain, d.del);
          if (d.ins.length > 0) entry.text.insert(d.retain, d.ins);
          entry.meta.set("path", file.path);
          entry.meta.set("deleted", false);
        });
        entry.lastContent = content;
        await this.store.writeBlob(noteId, Y.encodeStateAsUpdate(entry.doc));
      }
      i++;
      if (showProgress && i % 25 === 0) {
        new Notice(`Cloud Relay: memindai ${i}/${files.length}…`);
      }
      if (i % 10 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await this.store.writeIndex(this.index);
  }

  sendSyncSteps(conn: Conn) {
    for (const [id, entry] of this.docs) {
      if (entry.meta.get("path") || entry.text.length > 0) {
        const sv = Y.encodeStateVector(entry.doc);
        conn.send(encodeFrame(MSG_SYNC_STEP1, id, new Uint8Array(sv)));
      }
    }
  }

  setConn(conn: Conn | null) {
    this.conn = conn;
  }

  suspend() {
    this.suspended = true;
  }

  async reset() {
    this.index = {};
    this.docs.clear();
    this.applyingRemoteByPath.clear();
    await this.store.archive();
    await this.store.ensureDir();
    await this.store.writeIndex(this.index);
    this.suspended = false;
  }

  async onDocList(noteIds: string[]) {
    for (const id of noteIds) {
      if (!this.docs.has(id)) {
        this.index[id] = this.index[id] ?? { path: "", deleted: false };
        await this.ensureDoc(id, this.index[id].path);
      }
      const entry = this.docs.get(id);
      if (entry && this.conn) {
        const sv = Y.encodeStateVector(entry.doc);
        this.conn.send(encodeFrame(MSG_SYNC_STEP1, id, new Uint8Array(sv)));
      }
    }
    await this.store.writeIndex(this.index);
  }

  onSyncStep1(noteId: string, sv: Uint8Array) {
    const entry = this.docs.get(noteId);
    if (!entry || !this.conn) return;
    const diff = Y.encodeStateAsUpdate(entry.doc, sv);
    this.conn.send(encodeFrame(MSG_SYNC_STEP2, noteId, diff));
  }

  onSyncStep2(noteId: string, update: Uint8Array) {
    this.queueApply(noteId, update);
  }

  onUpdate(noteId: string, update: Uint8Array) {
    this.queueApply(noteId, update);
  }

  onFileModify(file: TFile, content: string) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    if (this.applyingRemoteByPath.has(file.path)) return;
    let noteId = this.findNoteIdByPath(file.path);
    if (!noteId) {
      noteId = crypto.randomUUID();
      this.index[noteId] = { path: file.path, deleted: false };
      this.store.writeIndex(this.index);
    }
    this.ensureDoc(noteId, file.path).then(() => {
      const entry = this.docs.get(noteId);
      if (!entry) return;
      if (content === entry.lastContent) return;
      const d = diffText(entry.lastContent, content);
      entry.doc.transact(() => {
        if (d.del > 0) entry.text.delete(d.retain, d.del);
        if (d.ins.length > 0) entry.text.insert(d.retain, d.ins);
        entry.meta.set("path", file.path);
        entry.meta.set("deleted", false);
      });
      entry.lastContent = content;
      entry.lastPath = file.path;
      this.store.writeIndex(this.index);
    });
  }

  onFileCreate(file: TFile, content: string) {
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
    this.ensureDoc(noteId, path).then(() => {
      const entry = this.docs.get(noteId);
      if (!entry) return;
      entry.doc.transact(() => {
        entry.meta.set("deleted", true);
      });
      this.index[noteId].deleted = true;
      this.store.writeIndex(this.index);
    });
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
    this.ensureDoc(noteId, oldPath).then(() => {
      const entry = this.docs.get(noteId);
      if (!entry) return;
      entry.doc.transact(() => {
        entry.meta.set("path", file.path);
      });
      this.index[noteId].path = file.path;
      this.store.writeIndex(this.index);
    });
  }

  private async applyRemote(noteId: string, update: Uint8Array) {
    if (this.suspended) return;
    await new Promise((r) => setTimeout(r, 0));
    await this.ensureDoc(noteId, this.index[noteId]?.path ?? "");
    const entry = this.docs.get(noteId);
    if (!entry) return;
    const oldContent = entry.text.toString();
    const oldPath = entry.meta.get("path") as string | undefined;
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
      await this.store.writeIndex(this.index);
      entry.lastContent = "";
      entry.lastPath = existingPath;
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
      await this.store.writeIndex(this.index);
      entry.lastContent = newContent;
      entry.lastPath = finalPath;
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
      await this.store.writeIndex(this.index);
      entry.lastContent = newContent;
      entry.lastPath = newPath;
      return;
    }

    if (newContent !== oldContent) {
      const file = this.vault.getAbstractFileByPath(existingPath);
      if (file instanceof TFile) {
        this.applyingRemoteByPath.add(existingPath);
        await this.vault.modify(file, newContent);
        this.applyingRemoteByPath.delete(existingPath);
      }
    }
    entry.lastContent = newContent;
    entry.lastPath = existingPath;
  }

  private async ensureDoc(noteId: string, path: string) {
    if (this.docs.has(noteId)) return;
    const doc = new Y.Doc();
    const blob = await this.store.readBlob(noteId);
    if (blob) Y.applyUpdate(doc, blob);
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
        this.store.writeBlob(noteId, Y.encodeStateAsUpdate(doc));
      }
    });
    const entry: DocEntry = {
      doc,
      text,
      meta,
      lastContent: text.toString(),
      lastPath: path,
    };
    this.docs.set(noteId, entry);
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
