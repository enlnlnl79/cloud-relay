import { TFile } from "./obsidian-mock";

// Vault mock yang cukup lengkap untuk NoteSyncManager.
// `vaultIndexed` menyimulasikan index Obsidian: file yang "sudah terlihat"
// oleh Obsidian. File yang hanya ada di adapter (fs) tapi belum di index
// meniru kondisi startup indexing belum selesai.
export class MockAdapter {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  folders = new Set<string>();

  async exists(path: string) {
    return this.files.has(path) || this.folders.has(path);
  }

  async mkdir(path: string) {
    this.folders.add(path);
  }

  async stat(path: string) {
    const f = this.files.get(path);
    if (!f) return null;
    return { mtime: f.mtime, size: f.data.byteLength, type: "file" as const };
  }

  async list(path: string) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const files: string[] = [];
    const folders = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) {
        folders.add(prefix + rest.split("/")[0]);
      } else {
        files.push(key);
      }
    }
    for (const f of this.folders) {
      if (f.startsWith(prefix)) folders.add(f);
    }
    return { files, folders: Array.from(folders) };
  }

  async read(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT ${path}`);
    return new TextDecoder().decode(f.data);
  }

  async readBinary(path: string) {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT ${path}`);
    return f.data.slice().buffer;
  }

  async write(path: string, data: string) {
    this.files.set(path, {
      data: new TextEncoder().encode(data),
      mtime: Date.now(),
    });
  }

  async writeBinary(path: string, data: ArrayBuffer) {
    this.files.set(path, {
      data: new Uint8Array(data),
      mtime: Date.now(),
    });
  }

  async remove(path: string) {
    this.files.delete(path);
  }

  async rename(from: string, to: string) {
    const f = this.files.get(from);
    if (!f) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.files.set(to, f);
  }
}

export class MockVault {
  adapter = new MockAdapter();
  // file yang "terlihat" oleh Obsidian (index) — bisa tertinggal dari fs
  indexed = new Map<string, TFile>();
  events: { type: string; fn: (...args: unknown[]) => void }[] = [];

  on(type: string, fn: (...args: unknown[]) => void) {
    this.events.push({ type, fn });
    return { type, fn };
  }

  emit(type: string, ...args: unknown[]) {
    for (const e of this.events) {
      if (e.type === type) e.fn(...args);
    }
  }

  // ---- fs helpers (menulis fs + index sekaligus, meniru Obsidian) ----
  fsWrite(path: string, content: string, opts?: { indexed?: boolean }) {
    this.adapter.files.set(path, {
      data: new TextEncoder().encode(content),
      mtime: Date.now(),
    });
    if (opts?.indexed !== false) {
      this.indexed.set(
        path,
        new TFile(path, {
          mtime: this.adapter.files.get(path)!.mtime,
          size: content.length,
        })
      );
    }
  }

  fsWriteBinary(path: string, data: Uint8Array, opts?: { indexed?: boolean }) {
    this.adapter.files.set(path, { data, mtime: Date.now() });
    if (opts?.indexed !== false) {
      this.indexed.set(
        path,
        new TFile(path, {
          mtime: this.adapter.files.get(path)!.mtime,
          size: data.byteLength,
        })
      );
    }
  }

  get mtimeNow() {
    return this.adapter.files.entries.length;
  }

  // ---- API Vault yang dipakai NoteSyncManager ----
  getFiles() {
    return Array.from(this.indexed.values());
  }

  getMarkdownFiles() {
    return this.getFiles().filter((f) => f.extension === "md");
  }

  getAbstractFileByPath(path: string) {
    return this.indexed.get(path) ?? null;
  }

  async read(file: TFile) {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile) {
    return this.adapter.readBinary(file.path);
  }

  async create(path: string, content: string) {
    if (this.indexed.has(path)) throw new Error(`EEXISTS ${path}`);
    this.fsWrite(path, content);
  }

  async createBinary(path: string, data: ArrayBuffer) {
    if (this.indexed.has(path)) throw new Error(`EEXISTS ${path}`);
    this.fsWriteBinary(path, new Uint8Array(data));
  }

  async modify(file: TFile, content: string) {
    this.fsWrite(file.path, content);
    // simulasikan event modify datang segera setelah tulis
    const nf = this.indexed.get(file.path)!;
    this.emit("modify", nf);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer) {
    this.fsWriteBinary(file.path, new Uint8Array(data));
    this.emit("modify", this.indexed.get(file.path)!);
  }

  async delete(file: TFile) {
    this.adapter.files.delete(file.path);
    this.indexed.delete(file.path);
    this.emit("delete", new TFile(file.path, file.stat));
  }

  async trash(file: TFile) {
    await this.delete(file);
  }

  async rename(file: TFile, newPath: string) {
    if (this.indexed.has(newPath)) throw new Error(`EEXISTS ${newPath}`);
    const old = this.adapter.files.get(file.path);
    if (!old) throw new Error(`ENOENT ${file.path}`);
    this.adapter.files.delete(file.path);
    this.adapter.files.set(newPath, old);
    this.indexed.delete(file.path);
    this.indexed.set(
      newPath,
      new TFile(newPath, { mtime: old.mtime, size: old.data.byteLength })
    );
    this.emit("rename", this.indexed.get(newPath)!, file.path);
  }

  async createFolder(path: string) {
    this.adapter.folders.add(path);
  }
}
