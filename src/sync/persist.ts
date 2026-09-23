import { DataAdapter } from "obsidian";

export interface NoteIndex {
  path: string;
  deleted: boolean;
}

export class SyncStore {
  constructor(
    private adapter: DataAdapter,
    public readonly dir: string
  ) {}

  async ensureDir() {
    if (!(await this.adapter.exists(this.dir))) {
      await this.adapter.mkdir(this.dir);
    }
  }

  async readBlob(noteId: string): Promise<Uint8Array | null> {
    const path = `${this.dir}/${noteId}.bin`;
    if (!(await this.adapter.exists(path))) return null;
    return new Uint8Array(await this.adapter.readBinary(path));
  }

  async writeBlob(noteId: string, data: Uint8Array) {
    const buf = data.slice().buffer;
    await this.adapter.writeBinary(`${this.dir}/${noteId}.bin`, buf);
  }

  async readIndex(): Promise<Record<string, NoteIndex>> {
    const path = `${this.dir}/index.json`;
    if (!(await this.adapter.exists(path))) return {};
    try {
      return JSON.parse(await this.adapter.read(path));
    } catch {
      return {};
    }
  }

  async writeIndex(index: Record<string, NoteIndex>) {
    await this.adapter.write(
      `${this.dir}/index.json`,
      JSON.stringify(index, null, 2)
    );
  }
}
