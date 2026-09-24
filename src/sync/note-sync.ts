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

const ATTACH_ID = "__attachments__";
const HIDDEN_ID = "__hiddens__";
const FOLDER_ID = "__folders__";

interface AttachMeta {
  sha: string;
  size: number;
  deleted: boolean;
}

const HIDDEN_FILES = [
  "app.json",
  "appearance.json",
  "community-plugins.json",
  "core-plugins.json",
  "hotkeys.json",
  "graph.json",
];

const HIDDEN_DIRS = ["themes", "snippets"];

function isHiddenSyncable(path: string): boolean {
  const parts = path.split("/");
  return (
    HIDDEN_FILES.includes(parts[parts.length - 1]) ||
    HIDDEN_DIRS.includes(parts[0])
  );
}

const skipNoticeShown = new Set<string>();

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const PERSIST_DEBOUNCE_MS = 3000;

export class NoteSyncManager {
  private index: Record<string, NoteIndex> = {};
  private docs = new Map<string, DocEntry>();
  private svCache = new Map<string, Uint8Array>();
  private applyingRemoteByPath = new Set<string>();
  private conn: Conn | null = null;
  private suspended = false;
  private pendingPush = new Set<string>();
  private applySerial: Promise<void> = Promise.resolve();
  private persistTimers = new Map<string, number>();
  private indexTimer: number | null = null;
  private selfWrites = new Map<string, { mtime: number; until: number }>();
  private http: { baseUrl: string; token: string } | null = null;
  private maxNoteBytes = 0;
  private attachSeen: Record<string, { sha: string; mtime: number }> = {};
  private attachReconcileTimer: number | null = null;
  private flushTimer: number | null = null;

  private markSelfWrite(path: string, mtime: number) {
    this.selfWrites.set(path, { mtime, until: Date.now() + 5000 });
  }

  private isSelfWrite(path: string, mtime: number): boolean {
    const sw = this.selfWrites.get(path);
    if (!sw) return false;
    if (Date.now() > sw.until) {
      this.selfWrites.delete(path);
      return false;
    }
    return mtime <= sw.mtime + 5;
  }

  private startFlushLoop() {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setInterval(() => {
      for (const id of this.persistTimers.keys()) {
        void this.persistNow(id);
      }
    }, 2000);
  }

  private stopFlushLoop() {
    if (this.flushTimer !== null) {
      window.clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  constructor(
    private app: App,
    private vault: Vault,
    private store: SyncStore
  ) {}

  setHttpTransport(http: { baseUrl: string; token: string } | null) {
    this.http = http;
  }

  setMaxNoteBytes(n: number) {
    this.maxNoteBytes = n;
  }

  async init(showProgress = false) {
    await this.store.ensureDir();
    // MERGE index disk dengan in-memory (in-memory menang) — mencegah
    // init ulang membuang pengetahuan note yang belum ter-flush ke disk
    // (akar duplikasi note-id → ping-pong konflik antar device)
    const diskIndex = await this.store.readIndex();
    this.index = { ...diskIndex, ...this.index };
    this.attachSeen = { ...(await this.store.readAttachSeen()), ...this.attachSeen };
    this.hiddenSeen = { ...(await this.store.readHiddenSeen()), ...this.hiddenSeen };

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
      if (this.guardSize(file)) continue;
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
            const docLooksStale =
              entry.lastContent.length === 0 &&
              content.length > 0 &&
              idx.mtime !== 0;
            if (docLooksStale) {
              // blob lokal tertinggal (crash/debounce) — JANGAN insert ulang,
              // isi akan dipulihkan dari server via sync. Hanya catat mtime.
              console.warn(
                "cloud-relay: blob lokal stale utk",
                file.path,
                "— skip diff, tunggu sync dari server"
              );
            } else {
              const d = diffText(entry.lastContent, content);
              entry.doc.transact(() => {
                if (d.del > 0) entry.text.delete(d.retain, d.del);
                if (d.ins.length > 0) entry.text.insert(d.retain, d.ins);
                entry.meta.set("path", file.path);
                entry.meta.set("deleted", false);
              });
              entry.lastContent = content;
              await this.persistNow(noteId);
            }
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
    // tulis index LANGSUNG — disk harus segar setelah init (bukan debounce),
    // supaya init berikutnya tidak membaca index basi → duplikat note-id
    await this.store.writeIndex(this.index);
    this.scheduleIndexWrite();
    await this.ensureDoc(ATTACH_ID, "");
    this.markLocallyDeletedAttachments();
  }

  private attachMap() {
    const entry = this.docs.get(ATTACH_ID);
    return entry
      ? (entry.doc.getMap<AttachMeta>("files") as Y.Map<AttachMeta>)
      : null;
  }

  private markLocallyDeletedAttachments() {
    const map = this.attachMap();
    if (!map) return;
    let changed = false;
    void (async () => {
      for (const path of Object.keys(this.attachSeen)) {
        if (this.suspended) return;
        if (this.vault.getAbstractFileByPath(path)) continue;
        // cek fs-level: file mungkin ada tapi belum ter-index Obsidian (startup)
        let existsOnDisk = false;
        try {
          existsOnDisk = await this.app.vault.adapter.exists(path);
        } catch {}
        if (existsOnDisk) continue;
        const entry = map.get(path);
        if (entry && !entry.deleted) {
          map.set(path, { ...entry, deleted: true });
          changed = true;
        }
        delete this.attachSeen[path];
      }
      if (changed) void this.store.writeAttachSeen(this.attachSeen);
    })();
  }

  async initAttachments(showProgress = false) {
    if (!this.http) return;
    await this.ensureDoc(ATTACH_ID, "");
    const map = this.attachMap();
    if (!map) return;
    const files = this.vault.getFiles().filter(
      (f) => f.extension !== "md" && !this.applyingRemoteByPath.has(f.path)
    );
    let i = 0;
    for (const file of files) {
      if (this.suspended) return;
      try {
        const seen = this.attachSeen[file.path];
        if (seen && seen.mtime === file.stat.mtime) {
          const entry = map.get(file.path);
          if (!entry || entry.sha !== seen.sha || entry.deleted) {
            map.set(file.path, {
              sha: seen.sha,
              size: file.stat.size,
              deleted: false,
            });
          }
          continue;
        }
        const buf = await this.vault.readBinary(file);
        const sha = await sha256Hex(buf);
        const entry = map.get(file.path);
        if (!entry || entry.sha !== sha || entry.deleted) {
          await this.uploadBlob(sha, new Uint8Array(buf));
          map.set(file.path, {
            sha,
            size: file.stat.size,
            deleted: false,
          });
        }
        this.attachSeen[file.path] = { sha, mtime: file.stat.mtime };
      } catch (e) {
        console.warn("cloud-relay: gagal siapkan lampiran", file.path, e);
      }
      i++;
      if (showProgress && i % 50 === 0) {
        new Notice(`Cloud Relay: lampiran ${i}/${files.length}…`);
      }
      if (i % 5 === 0) await sleep0();
    }
    await this.store.writeAttachSeen(this.attachSeen);
  }

  onAttachmentChange(file: TFile, deleted = false, oldPath?: string) {
    if (this.suspended) return;
    if (file.extension === "md") return;
    const path = file.path;
    let mtime = 0;
    try {
      mtime = file.stat.mtime;
    } catch {
      mtime = Number.MAX_SAFE_INTEGER;
    }
    if (!deleted && this.isSelfWrite(path, mtime)) return;
    if (!deleted && this.applyingRemoteByPath.has(path)) return;
    void (async () => {
      const map = this.attachMap();
      if (!map) return;
      if (oldPath && oldPath !== path) {
        const prev = map.get(oldPath);
        if (prev) {
          map.delete(oldPath);
          map.set(path, prev);
          delete this.attachSeen[oldPath];
        }
      }
      if (deleted) {
        const prev = map.get(path);
        if (prev && !prev.deleted) {
          map.set(path, { ...prev, deleted: true });
        }
        delete this.attachSeen[path];
      } else {
        try {
          const buf = await this.vault.readBinary(file);
          const sha = await sha256Hex(buf);
          const prev = map.get(path);
          if (prev && prev.sha === sha && !prev.deleted) {
            this.attachSeen[path] = { sha, mtime: file.stat.mtime };
            return;
          }
          await this.uploadBlob(sha, new Uint8Array(buf));
          map.set(path, {
            sha,
            size: file.stat.size,
            deleted: false,
          });
          this.attachSeen[path] = { sha, mtime: file.stat.mtime };
        } catch (e) {
          console.warn("cloud-relay: upload lampiran gagal", path, e);
        }
      }
      void this.store.writeAttachSeen(this.attachSeen);
    })();
  }

  private hiddenSyncEnabled = false;
  private hiddenSeen: Record<string, { sha: string; mtime: number }> = {};
  private hiddenReconcileTimer: number | null = null;

  setHiddenSyncEnabled(on: boolean) {
    this.hiddenSyncEnabled = on;
    if (!on && this.hiddenReconcileTimer !== null) {
      window.clearTimeout(this.hiddenReconcileTimer);
      this.hiddenReconcileTimer = null;
    }
  }

  private async listHiddenFiles(): Promise<{ path: string; mtime: number; size: number }[]> {
    const acc: { path: string; mtime: number; size: number }[] = [];
    const walk = async (dir: string) => {
      let list: { files: string[]; folders: string[] };
      try {
        list = await this.app.vault.adapter.list(dir);
      } catch {
        return;
      }
      for (const f of list.files) {
        const rel = f.replace(/^\.obsidian\//, "");
        if (!rel || rel.startsWith("plugins/cloud-relay/")) continue;
        const top = rel.split("/")[0];
        const name = rel.split("/").pop() ?? "";
        if (!HIDDEN_FILES.includes(name) && !HIDDEN_DIRS.includes(top)) continue;
        const st = await this.app.vault.adapter.stat(f);
        if (st) acc.push({ path: rel, mtime: st.mtime, size: st.size });
      }
      for (const d of list.folders) {
        const rel = d.replace(/^\.obsidian\//, "");
        if (HIDDEN_DIRS.includes(rel.split("/")[0])) await walk(d);
      }
    };
    await walk(".obsidian");
    return acc;
  }

  private async listVaultFolders(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let list: { files: string[]; folders: string[] };
      try { list = await this.app.vault.adapter.list(dir); } catch { return; }
      for (const folder of list.folders) {
        const clean = folder.replace(/^\//, "").replace(/\/$/, "");
        if (!clean || clean.startsWith(".obsidian")) continue;
        out.push(clean);
        await walk(folder);
      }
    };
    await walk("");
    return Array.from(new Set(out));
  }

  async initFolders() {
    await this.ensureDoc(FOLDER_ID, "");
    await this.scanFolders();
  }

  async scanFolders() {
    if (!this.conn) return;
    const map = this.docMap(FOLDER_ID) as unknown as Y.Map<boolean> | null;
    if (!map) return;
    const local = new Set(await this.listVaultFolders());
    for (const folder of local) map.set(folder, true);
    for (const [folder, active] of map.entries()) {
      if (active && !local.has(folder)) map.set(folder, false);
    }
  }

  onFolderChange(path: string, deleted = false, oldPath?: string) {
    if (this.suspended || !this.conn || path.startsWith(".obsidian")) return;
    const map = this.docMap(FOLDER_ID) as unknown as Y.Map<boolean> | null;
    if (!map) return;
    if (oldPath && oldPath !== path) {
      const old = map.get(oldPath);
      if (old) map.delete(oldPath);
    }
    map.set(path, !deleted);
  }

  private async reconcileFoldersFromRemote() {
    const map = this.docMap(FOLDER_ID) as unknown as Y.Map<boolean> | null;
    if (!map) return;
    for (const [folder, active] of map.entries()) {
      if (active) {
        try { await this.ensureParentFolders(`${folder}/.cloud-relay-folder`); } catch {}
        if (!(await this.app.vault.adapter.exists(folder))) {
          try { await this.app.vault.createFolder(folder); } catch {}
        }
      } else if (await this.app.vault.adapter.exists(folder)) {
        try { await this.app.vault.adapter.remove(folder); } catch {}
      }
    }
  }

  async folderDiagnostic(): Promise<{ local: number; meta: number }> {
    const map = this.docMap(FOLDER_ID) as unknown as Y.Map<boolean> | null;
    return {
      local: (await this.listVaultFolders()).length,
      meta: map ? Array.from(map.values()).filter(Boolean).length : 0,
    };
  }

  async initHiddenFiles(showProgress = false) {
    if (!this.http || !this.hiddenSyncEnabled) {
      console.warn("cloud-relay: initHidden skip — http:", !!this.http, "enabled:", this.hiddenSyncEnabled);
      return;
    }
    await this.ensureDoc(HIDDEN_ID, "");
    const map = this.docMap(HIDDEN_ID) as unknown as Y.Map<AttachMeta> | null;
    if (!map) return;
    let i = 0;
    const files = await this.listHiddenFiles();
    for (const f of files) {
      if (this.suspended) return;
      try {
        const seen = this.hiddenSeen[f.path];
        if (seen && seen.mtime === f.mtime) {
          const entry = map.get(f.path);
          if (entry && entry.sha === seen.sha && !entry.deleted) continue;
        }
        const buf = await this.vault.adapter.readBinary(`.obsidian/${f.path}`);
        const sha = await sha256Hex(buf);
        const entry = map.get(f.path);
        if (!entry || entry.sha !== sha || entry.deleted) {
          await this.uploadBlob(sha, new Uint8Array(buf));
          map.set(f.path, { sha, size: f.size, deleted: false });
        }
        this.hiddenSeen[f.path] = { sha, mtime: f.mtime };
      } catch (e) {
        console.warn("cloud-relay: hidden file gagal dibaca", f.path, e);
      }
      i++;
      if (showProgress && i % 20 === 0) {
        new Notice(`Cloud Relay: pengaturan ${i}/${files.length}…`);
      }
    }
    // tandai file remote yang sudah tidak ada lokal (terhapus di device lain).
    // PENTING: cek via adapter (fs) — vault.getAbstractFileByPath TIDAK melacak .obsidian/
    for (const [path, meta] of map.entries()) {
      if (meta.deleted) continue;
      let existsLocally = false;
      try {
        existsLocally = await this.app.vault.adapter.exists(`.obsidian/${path}`);
      } catch {}
      if (!existsLocally) {
        map.set(path, { ...meta, deleted: true });
      }
    }
    await this.store.writeHiddenSeen(this.hiddenSeen);
  }

  onHiddenFileChange(path: string, deleted = false) {
    if (this.suspended || !this.hiddenSyncEnabled) return;
    if (!isHiddenSyncable(path)) return;
    if (!deleted && this.isSelfWriteObsidian(path)) return;
    void (async () => {
      const map = this.docMap(HIDDEN_ID) as unknown as Y.Map<AttachMeta> | null;
      if (!map) return;
      try {
        if (deleted) {
          const prev = map.get(path);
          if (prev && !prev.deleted) map.set(path, { ...prev, deleted: true });
          delete this.hiddenSeen[path];
        } else {
          const buf = await this.vault.adapter.readBinary(`.obsidian/${path}`);
          const sha = await sha256Hex(buf);
          const prev = map.get(path);
          if (prev && prev.sha === sha && !prev.deleted) return;
          await this.uploadBlob(sha, new Uint8Array(buf));
          map.set(path, { sha, size: buf.byteLength, deleted: false });
          const f = this.vault.getAbstractFileByPath(path);
          if (f instanceof TFile) {
            this.markSelfWriteObsidian(path, f.stat.mtime);
            this.hiddenSeen[path] = { sha, mtime: f.stat.mtime };
          }
        }
      } catch (e) {
        console.warn("cloud-relay: hidden change gagal", path, e);
      }
      await this.store.writeHiddenSeen(this.hiddenSeen);
    })();
  }

  private selfWritesObsidian = new Map<string, { mtime: number; until: number }>();

  private markSelfWriteObsidian(path: string, mtime: number) {
    this.selfWritesObsidian.set(path, { mtime, until: Date.now() + 5000 });
  }

  private isSelfWriteObsidian(path: string): boolean {
    const sw = this.selfWritesObsidian.get(path);
    if (!sw) return false;
    if (Date.now() > sw.until) {
      this.selfWritesObsidian.delete(path);
      return false;
    }
    return true;
  }

  private scheduleHiddenReconcile() {
    if (!this.hiddenSyncEnabled) return;
    if (this.hiddenReconcileTimer !== null)
      window.clearTimeout(this.hiddenReconcileTimer);
    this.hiddenReconcileTimer = window.setTimeout(() => {
      this.hiddenReconcileTimer = null;
      void this.reconcileHiddenFromRemote();
    }, 800);
  }

  private async reconcileHiddenFromRemote() {
    if (this.suspended) return;
    const map = this.docMap(HIDDEN_ID) as unknown as Y.Map<AttachMeta> | null;
    if (!map || !this.http) return;
    for (const [path, meta] of map.entries()) {
      if (this.suspended) return;
      const localPath = `.obsidian/${path}`;
      let localExists = false;
      try {
        localExists = await this.app.vault.adapter.exists(localPath);
      } catch {}
      if (meta.deleted) {
        if (localExists) {
          try {
            await this.app.vault.adapter.remove(localPath);
            console.log("cloud-relay: hidden file dihapus (remote)", path);
          } catch {}
        }
        continue;
      }
      const seen = this.hiddenSeen[path];
      if (localExists && seen && seen.sha === meta.sha) continue;
      try {
        const buf = await this.downloadBlob(meta.sha);
        const cur = new Uint8Array(buf);
        if (localExists && seen && seen.sha) {
          try {
            const curLocal = new Uint8Array(
              await this.app.vault.adapter.readBinary(localPath)
            );
            const curLocalSha = await sha256Hex(curLocal.buffer);
            if (curLocalSha === meta.sha) {
              this.hiddenSeen[path] = { sha: meta.sha, mtime: Date.now() };
              continue;
            }
          } catch {}
        }
        this.markSelfWriteObsidian(path, Date.now());
        await this.app.vault.adapter.writeBinary(localPath, buf);
        if (!localExists) this.markSelfWriteObsidian(path, Date.now());
        this.hiddenSeen[path] = { sha: meta.sha, mtime: Date.now() };
        new Notice(`Cloud Relay: pengaturan diperbarui — ${path}`);
      } catch (e) {
        console.warn("cloud-relay: gagal tarik hidden file", path, e);
      }
      await sleep0();
    }
    await this.store.writeHiddenSeen(this.hiddenSeen);
  }

  async hiddenDiagnostic(): Promise<{ local: number; meta: number }> {
    const map = this.docMap(HIDDEN_ID) as unknown as Y.Map<AttachMeta> | null;
    let meta = 0;
    if (map) {
      for (const [, v] of map.entries()) if (!v.deleted) meta++;
    }
    return { local: (await this.listHiddenFiles()).length, meta };
  }

  private docMap(docId: string): Y.Map<unknown> | null {
    const entry = this.docs.get(docId);
    return entry ? (entry.meta as unknown as Y.Map<unknown>) : null;
  }

  async uploadHiddenForce(): Promise<number> {
    if (!this.http) return 0;
    await this.ensureDoc(HIDDEN_ID, "");
    const map = this.docMap(HIDDEN_ID) as unknown as Y.Map<AttachMeta> | null;
    if (!map) return 0;
    let n = 0;
    for (const f of await this.listHiddenFiles()) {
      try {
        const buf = await this.vault.adapter.readBinary(`.obsidian/${f.path}`);
        const sha = await sha256Hex(buf);
        await this.uploadBlob(sha, new Uint8Array(buf));
        map.set(f.path, { sha, size: f.size, deleted: false });
        this.hiddenSeen[f.path] = { sha, mtime: f.mtime };
        n++;
      } catch {}
    }
    await this.store.writeHiddenSeen(this.hiddenSeen);
    return n;
  }

  private async uploadBlob(sha: string, data: Uint8Array) {
    if (!this.http) throw new Error("transport belum siap");
    const url = `${this.http.baseUrl.replace(/\/$/, "")}/v1/blobs/${sha}?token=${encodeURIComponent(this.http.token)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: data.slice().buffer as ArrayBuffer,
    });
    if (!res.ok) throw new Error(`upload blob HTTP ${res.status}`);
  }

  private async downloadBlob(sha: string): Promise<ArrayBuffer> {
    if (!this.http) throw new Error("transport belum siap");
    const url = `${this.http.baseUrl.replace(/\/$/, "")}/v1/blobs/${sha}?token=${encodeURIComponent(this.http.token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download blob HTTP ${res.status}`);
    return await res.arrayBuffer();
  }

  private scheduleAttachReconcile() {
    if (this.attachReconcileTimer !== null)
      window.clearTimeout(this.attachReconcileTimer);
    this.attachReconcileTimer = window.setTimeout(() => {
      this.attachReconcileTimer = null;
      void this.reconcileAttachmentsFromRemote();
    }, 800);
  }

  private async reconcileAttachmentsFromRemote() {
    if (this.suspended) return;
    const map = this.attachMap();
    if (!map || !this.http) return;
    for (const [path, meta] of map.entries()) {
      if (this.suspended) return;
      if (meta.deleted) {
        if (this.attachSeen[path]) {
          const file = this.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            let mtime = 0;
            try {
              mtime = file.stat.mtime;
            } catch {}
            this.applyingRemoteByPath.add(path);
            try {
              await this.vault.trash(file, true);
            } catch {
              try {
                await this.vault.delete(file);
              } catch {}
            }
            this.applyingRemoteByPath.delete(path);
            this.markSelfWrite(path, mtime);
          }
          delete this.attachSeen[path];
        }
        continue;
      }
      const file = this.vault.getAbstractFileByPath(path);
      if (
        file instanceof TFile &&
        file.stat.size === meta.size &&
        this.attachSeen[path]?.sha === meta.sha
      ) {
        continue;
      }
      try {
        const buf = await this.downloadBlob(meta.sha);
        this.applyingRemoteByPath.add(path);
        try {
          await this.ensureParentFolders(path);
          if (file instanceof TFile) await this.vault.modifyBinary(file, buf);
          else await this.vault.createBinary(path, buf);
          const nf = this.vault.getAbstractFileByPath(path);
          if (nf instanceof TFile) {
            this.markSelfWrite(path, nf.stat.mtime);
            this.attachSeen[path] = { sha: meta.sha, mtime: nf.stat.mtime };
          }
        } finally {
          this.applyingRemoteByPath.delete(path);
        }
        if (!this.attachSeen[path]) {
          this.attachSeen[path] = { sha: meta.sha, mtime: Date.now() };
        }
      } catch (e) {
        console.warn("cloud-relay: gagal tarik lampiran", path, e);
      }
      await sleep0();
    }
    await this.store.writeAttachSeen(this.attachSeen);
  }

  attachmentDiagnostic(): { local: number; meta: number } {
    const map = this.attachMap();
    let meta = 0;
    if (map) {
      for (const [, v] of map.entries()) if (!v.deleted) meta++;
    }
    return {
      local: this.vault.getFiles().filter((f) => f.extension !== "md").length,
      meta,
    };
  }

  setConn(conn: Conn | null) {
    this.conn = conn;
    if (conn) {
      this.startFlushLoop();
      // push note yang dibuat/diubah saat belum connect
      void this.flushPendingPush(conn);
    } else {
      this.stopFlushLoop();
    }
  }

  async flushPendingPush(conn: Conn) {
    if (this.pendingPush.size === 0) return;
    const ids = Array.from(this.pendingPush);
    this.pendingPush.clear();
    for (const id of ids) {
      if (this.index[id]?.deleted) continue;
      await this.ensureDoc(id, this.index[id]?.path ?? "");
      const entry = this.docs.get(id);
      if (!entry) continue;
      const update = Y.encodeStateAsUpdate(entry.doc);
      conn.send(encodeFrame(MSG_UPDATE, id, update));
    }
  }

  suspend() {
    this.suspended = true;
    this.stopFlushLoop();
  }

  resumeAfterReset() {
    this.suspended = false;
  }

  async reset() {
    for (const t of this.persistTimers.values()) window.clearTimeout(t);
    this.persistTimers.clear();
    if (this.indexTimer !== null) window.clearTimeout(this.indexTimer);
    this.indexTimer = null;
    this.selfWrites.clear();
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
    await this.store.writeAttachSeen(this.attachSeen);
    await this.store.writeHiddenSeen(this.hiddenSeen);
  }

  async sendSyncSteps(conn: Conn) {
    const ids = Object.keys(this.index).filter((id) => !this.index[id].deleted);
    if (!ids.includes(FOLDER_ID)) ids.push(FOLDER_ID);
    if (this.hiddenSyncEnabled && !ids.includes(HIDDEN_ID)) ids.push(HIDDEN_ID);
    for (const id of ids) {
      if (id === FOLDER_ID) await this.ensureDoc(FOLDER_ID, "");
      if (id === HIDDEN_ID) await this.ensureDoc(HIDDEN_ID, "");
      let sv = this.svCache.get(id);
      if (!sv) {
        await this.ensureDoc(id, this.index[id]?.path);
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
      if (this.conn && sv.length > 0) {
        this.conn.send(encodeFrame(MSG_SYNC_STEP1, id, sv));
      }
    }
    this.scheduleIndexWrite();
    this.scheduleInitAttachments();
  }

  private attachmentsInitRunning = false;
  private attachmentsInitPending = false;

  private scheduleInitAttachments() {
    if (this.attachmentsInitRunning) {
      this.attachmentsInitPending = true;
      return;
    }
    this.attachmentsInitRunning = true;
    void this.initAttachments()
      .catch(() => {})
      .finally(() => {
        this.attachmentsInitRunning = false;
        if (this.attachmentsInitPending) {
          this.attachmentsInitPending = false;
          this.scheduleInitAttachments();
        }
      });
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
    this.applyQueueDepth++;
    this.applySerial = this.applySerial
      .then(() => this.applyRemote(noteId, update))
      .catch((e) => console.error("cloud-relay apply gagal:", e))
      .finally(() => {
        this.applyQueueDepth--;
      });
  }

  private applyQueueDepth = 0;

  applyQueueSize(): number {
    return this.applyQueueDepth;
  }

  onFileModify(file: TFile, content: string) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    if (this.isSelfWrite(file.path, file.stat.mtime)) return;
    if (this.applyingRemoteByPath.has(file.path)) return;
    if (this.guardSize(file)) return;
    let noteId = this.findNoteIdByPath(file.path);
    let wasKnown = true;
    if (!noteId) {
      noteId = crypto.randomUUID();
      this.index[noteId] = { path: file.path, deleted: false, mtime: 0 };
      wasKnown = false;
      // note baru: tulis index LANGSUNG (jarang terjadi, murah) —
      // debounce bisa membuat index disk basi → note-id dobel di init berikutnya
      void this.store.writeIndex(this.index);
    }
    const id = noteId;
    const isNewNote = !wasKnown;
    this.index[id].mtime = file.stat.mtime;
    this.scheduleIndexWrite();
    void (async () => {
      await this.ensureDoc(id, file.path);
      const entry = this.docs.get(id);
      if (!entry) return;
      if (content === entry.lastContent) {
        this.pushFullStateIfUnknown(id);
        return;
      }
      const idx = this.index[id];
      if (
        !isNewNote &&
        entry.lastContent.length === 0 &&
        content.length > 0 &&
        idx &&
        idx.mtime !== 0
      ) {
        // doc lokal tertinggal (blob stale) — tunggu sync dari server,
        // jangan insert ulang isi (duplikasi CRDT).
        // (isNewNote tidak boleh masuk sini: doc baru memang belum ada history)
        idx.mtime = file.stat.mtime;
        this.scheduleIndexWrite();
        return;
      }
      const d = diffText(entry.lastContent, content);
      entry.doc.transact(() => {
        if (d.del > 0) entry.text.delete(d.retain, d.del);
        if (d.ins.length > 0) entry.text.insert(d.retain, d.ins);
        // jangan set meta nilainya sama — bug Yjs 13.6.x (update apply kosong)
        if (entry.meta.get("path") !== file.path) entry.meta.set("path", file.path);
        if (entry.meta.get("deleted") !== false) entry.meta.set("deleted", false);
      });
      entry.lastContent = content;
      entry.lastPath = file.path;
    })();
  }

  private pushFullStateIfUnknown(noteId: string) {
    void this.flushPendingPush(this.conn!);
    void noteId;
  }

  onFileCreate(file: TFile, content: string) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    this.onFileModify(file, content);
  }

  onFileDelete(file: TFile) {
    if (this.suspended) return;
    if (!isSyncablePath(file.path)) return;
    let mtime = 0;
    try {
      mtime = file.stat.mtime;
    } catch {
      mtime = Number.MAX_SAFE_INTEGER;
    }
    if (this.isSelfWrite(file.path, mtime)) return;
    const path = file.path;
    if (this.applyingRemoteByPath.has(path)) return;
    const noteId = this.findNoteIdByPath(path);
    if (!noteId) return;
    this.index[noteId].deleted = true;
    // delete = event penting: tulis index langsung, bukan debounce
    void this.store.writeIndex(this.index);
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
    let mtime = 0;
    try {
      mtime = file.stat.mtime;
    } catch {
      mtime = Number.MAX_SAFE_INTEGER;
    }
    if (this.isSelfWrite(file.path, mtime)) return;
    if (this.isSelfWrite(oldPath, mtime)) return;
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
    if (noteId === ATTACH_ID) {
      let entry = this.docs.get(ATTACH_ID);
      if (!entry) {
        await this.ensureDoc(ATTACH_ID, "");
        entry = this.docs.get(ATTACH_ID);
      }
      if (!entry) return;
      entry.doc.transact(() => {
        Y.applyUpdate(entry!.doc, update);
      }, "remote");
      this.scheduleAttachReconcile();
      return;
    }
    if (noteId === FOLDER_ID) {
      let entry = this.docs.get(FOLDER_ID);
      if (!entry) {
        await this.ensureDoc(FOLDER_ID, "");
        entry = this.docs.get(FOLDER_ID);
      }
      if (!entry) return;
      entry.doc.transact(() => { Y.applyUpdate(entry!.doc, update); }, "remote");
      await this.reconcileFoldersFromRemote();
      return;
    }
    if (noteId === HIDDEN_ID) {
      let entry = this.docs.get(HIDDEN_ID);
      if (!entry) {
        await this.ensureDoc(HIDDEN_ID, "");
        entry = this.docs.get(HIDDEN_ID);
      }
      if (!entry) return;
      entry.doc.transact(() => {
        Y.applyUpdate(entry!.doc, update);
      }, "remote");
      this.scheduleHiddenReconcile();
      return;
    }
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
      // target: path index lokal, fallback ke path remote (note ID bisa beda
      // antar device pada mode merge — delete harus tetap menghapus file)
      const target = existingPath || newPath;
      if (target) {
        const file = this.vault.getAbstractFileByPath(target);
        if (file instanceof TFile) {
          let mtime = 0;
          try {
            mtime = file.stat.mtime;
          } catch {}
          this.applyingRemoteByPath.add(target);
          try {
            await this.vault.delete(file);
          } catch {}
          this.applyingRemoteByPath.delete(target);
          this.markSelfWrite(target, mtime);
        }
        // tandai juga note lokal pemilik path itu (kalau beda ID)
        const localOwner = this.findNoteIdByPath(target);
        if (localOwner && localOwner !== noteId) {
          this.index[localOwner].deleted = true;
        }
      }
      if (idx) idx.deleted = true;
      this.scheduleIndexWrite();
      entry.lastContent = "";
      entry.lastPath = existingPath;
      await this.persistNow(noteId);
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
        const nf = this.vault.getAbstractFileByPath(finalPath);
        if (nf instanceof TFile) {
          this.markSelfWrite(finalPath, nf.stat.mtime);
          this.index[noteId].mtime = nf.stat.mtime;
        }
      }
      this.scheduleIndexWrite();
      entry.lastContent = newContent;
      entry.lastPath = finalPath;
      await this.persistNow(noteId);
      return;
    }

    if (existingPath !== newPath && newPath) {
      const file = this.vault.getAbstractFileByPath(existingPath);
      if (file instanceof TFile) {
        let renameTarget = newPath;
        if (this.vault.getAbstractFileByPath(renameTarget)) {
          renameTarget = renameTarget.replace(
            /(\.md)$/i,
            " (konflik dari device lain)$1"
          );
          entry.doc.transact(() => {
            entry.meta.set("path", renameTarget);
          });
        }
        try {
          await this.ensureParentFolders(renameTarget);
          this.applyingRemoteByPath.add(renameTarget);
          try {
            await this.vault.rename(file, renameTarget);
          } catch (e) {
            console.warn("cloud-relay: rename gagal", existingPath, renameTarget, e);
          }
          this.applyingRemoteByPath.delete(renameTarget);
          const nf = this.vault.getAbstractFileByPath(renameTarget);
          if (nf instanceof TFile) {
            this.markSelfWrite(renameTarget, nf.stat.mtime);
            idx.mtime = nf.stat.mtime;
          }
          idx.path = renameTarget;
        } catch (e) {
          console.warn("cloud-relay: rename (folder) gagal", existingPath, newPath, e);
        }
      }
      idx.path = idx.path || newPath;
      this.scheduleIndexWrite();
      entry.lastContent = newContent;
      entry.lastPath = idx.path;
      await this.persistNow(noteId);
      return;
    }

    if (newContent !== oldContent) {
      const file = this.vault.getAbstractFileByPath(existingPath);
      if (file instanceof TFile) {
        this.applyingRemoteByPath.add(existingPath);
        await this.vault.modify(file, newContent);
        this.applyingRemoteByPath.delete(existingPath);
        const nf = this.vault.getAbstractFileByPath(existingPath);
        if (nf instanceof TFile) {
          this.markSelfWrite(existingPath, nf.stat.mtime);
          idx.mtime = nf.stat.mtime;
        }
        this.scheduleIndexWrite();
      }
    }
    entry.lastContent = newContent;
    entry.lastPath = existingPath;
    await this.persistNow(noteId);
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
        if (this.conn) {
          // BUG Yjs 13.6.x: update inkremental dari transact yang menyet
          // ulang meta (nilai sama) setelah init-transact menghasilkan update
          // yang apply-nya kosong. Solusi: kirim STATE PENUH — selalu valid,
          // idempotent di server (yrs merge).
          const full = Y.encodeStateAsUpdate(entry.doc);
          this.conn.send(encodeFrame(MSG_UPDATE, noteId, new Uint8Array(full)));
        } else {
          // belum connect — tandai, akan di-push penuh setelah connect
          this.pendingPush.add(noteId);
        }
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
      if (id === ATTACH_ID || id === HIDDEN_ID) continue;
      if (!idx.deleted && idx.path) {
        localNoteIds.push(id);
        pathById[id] = idx.path;
      }
    }
    return { localNoteIds, pathById };
  }

  private guardSize(file: TFile): boolean {
    if (this.maxNoteBytes <= 0) return false;
    if (file.stat.size <= this.maxNoteBytes) return false;
    if (!skipNoticeShown.has(file.path)) {
      skipNoticeShown.add(file.path);
      new Notice(
        `Cloud Relay: '${file.path}' (${(file.stat.size / 1024 / 1024).toFixed(1)} MB) melebihi batas 2 MB — dilewati dari sync`,
        10000
      );
      console.warn("cloud-relay: note terlalu besar, skip", file.path, file.stat.size);
    }
    return true;
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

export function diffText(oldS: string, newS: string): {
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
