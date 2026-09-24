// Stub modul "obsidian" untuk test di Node.
// Dipakai via esbuild alias saat bundling test entry.

export class TFile {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; size: number; ctime: number };

  constructor(path: string, stat?: { mtime: number; size: number }) {
    this.path = path;
    this.name = path.split("/").pop() ?? "";
    this.extension = this.name.includes(".")
      ? this.name.split(".").pop()!
      : "";
    this.stat = stat ?? {
      mtime: Date.now(),
      size: 0,
      ctime: Date.now(),
    };
    this.stat.size = this.stat.size ?? 0;
    this.stat.ctime = this.stat.ctime ?? this.stat.mtime;
  }
}

export class TFolder {
  path: string;
  name: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? "";
  }
}

export class TAbstractFile {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}

export class Notice {
  static notices: string[] = [];
  constructor(public message: string, public timeout?: number) {
    Notice.notices.push(message);
    console.log("[Notice]", message);
  }
}

export class Plugin {
  manifest = { dir: ".obsidian/plugins/cloud-relay", version: "test" };
  app: unknown;
  async loadData() {
    return {};
  }
  async saveData() {}
  addStatusBarItem() {
    return {
      setText() {},
      setAttribute() {},
      el: document.createElement("div"),
    };
  }
  addRibbonIcon() {}
  addSettingTab() {}
  registerEvent() {}
  register() {}
  registerDomEvent() {}
}

export class PluginSettingTab {
  constructor() {}
  display() {}
}

export class Setting {
  constructor(public containerEl: HTMLElement) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addButton() {
    return this;
  }
  addToggle() {
    return this;
  }
}

export class MarkdownView {}

export function requestUrl(opts: { url: string; method?: string; headers?: Record<string, string>; body?: string }) {
  return Promise.resolve({ status: 200, json: {} });
}

export function normalizePath(p: string) {
  return p;
}
