import { Notice, Plugin, requestUrl, TFile } from "obsidian";
import { CloudRelaySettings, DEFAULT_SETTINGS } from "./settings";
import { StatusBar } from "./sync/status";
import { RelayConnection } from "./sync/connection";
import { NoteSyncManager } from "./sync/note-sync";
import { SyncStore } from "./sync/persist";
import { CloudRelaySettingTab } from "./ui/settings-tab";

export default class CloudRelayPlugin extends Plugin {
  settings: CloudRelaySettings = DEFAULT_SETTINGS;
  private statusBar: StatusBar | null = null;
  private connection: RelayConnection | null = null;
  private syncManager: NoteSyncManager | null = null;
  private store: SyncStore | null = null;

  private async bootLog(msg: string) {
    try {
      const p = `${this.manifest.dir}/boot.log`;
      const stamp = new Date().toISOString();
      let prev = "";
      try {
        prev = await this.app.vault.adapter.read(p);
      } catch {}
      const lines = prev.split("\n").filter(Boolean);
      while (lines.length > 100) lines.shift(); // jangan tumbuh tanpa batas
      await this.app.vault.adapter.write(
        p,
        `${lines.join("\n")}\n${stamp} ${msg}\n`
      );
    } catch {}
  }

  async onload() {
    await this.loadSettings();
    await this.bootLog("onload start");

    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.store = new SyncStore(this.app.vault.adapter, `${this.manifest.dir}/sync`);
    this.syncManager = new NoteSyncManager(this.app, this.app.vault, this.store);

    try {
      await this.syncManager.init();
      await this.bootLog("init selesai");
    } catch (e) {
      await this.bootLog(`init ERROR: ${e}`);
    }

    this.registerVaultEvents();
    await this.bootLog("events terpasang");

    this.addRibbonIcon("refresh-cw", "Cloud Relay: sync sekarang", () => {
      if (this.connection && this.syncManager) {
        const conn = this.connection;
        const manager = this.syncManager;
        manager.onDocList([]);
        this.onConnectSync();
        new Notice("Cloud Relay: sync sekarang…");
      } else {
        new Notice("Cloud Relay: belum terhubung. Buka Settings → Cloud Relay.");
      }
    });

    this.addSettingTab(new CloudRelaySettingTab(this.app, this));

    if (this.settings.enabled && this.settings.vaultId) {
      this.startSync();
      void this.syncManager
        ?.initHiddenFiles(false)
        .then(() => {
          void this.bootLog("initHidden selesai");
          void this.syncManager?.initAttachments(false);
        })
        .catch((e) => this.bootLog(`initHidden ERROR: ${e}`));
    }
  }

  onunload() {
    this.statusBar?.warnIfBusy();
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.stopSync();
    void this.syncManager?.flush();
  }

  private registerVaultEvents() {
    const manager = this.syncManager;
    if (!manager) return;

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          if (file.extension === "md") {
            this.app.vault.read(file).then((content) => manager.onFileCreate(file, content));
          } else {
            manager.onAttachmentChange(file);
          }
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          if (file.extension === "md") {
            this.app.vault.read(file).then((content) => manager.onFileModify(file, content));
          } else {
            manager.onAttachmentChange(file);
          }
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          if (file.extension === "md") manager.onFileDelete(file);
          else manager.onAttachmentChange(file, true);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          if (file.extension === "md") manager.onFileRename(file, oldPath);
          else manager.onAttachmentChange(file, false, oldPath);
        }
      })
    );
  }

  private onConnectSync() {
    if (this.connection && this.syncManager) {
      this.syncManager.sendSyncSteps(this.connection);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async createVault(): Promise<boolean> {
    if (!this.settings.serverUrl) {
      new Notice("Cloud Relay: isi Server URL dulu.");
      return false;
    }
    if (!this.settings.adminToken) {
      new Notice("Cloud Relay: isi Admin token dulu (dari log server).");
      return false;
    }
    try {
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/v1/vaults`,
        method: "POST",
        headers: { "x-admin-token": this.settings.adminToken },
      });
      const body = res.json as { vault_id: string; token: string };
      this.settings.vaultId = body.vault_id;
      this.settings.vaultToken = body.token;
      this.settings.isPrimary = true;
      this.settings.enabled = true;
      await this.saveSettings();
      new Notice("Cloud Relay: vault berhasil dibuat ✓");
      this.startSync();
      return true;
    } catch (e) {
      const msg = `${e}`;
      if (msg.includes("401")) {
        new Notice(
          "Cloud Relay: admin token salah/belum diisi. Ambil dari server: docker compose logs | grep 'admin token'"
        );
      } else {
        new Notice(`Cloud Relay: tidak bisa menghubungi server (${msg}). Cek Server URL & tunnel.`);
      }
      return false;
    }
  }

  async wipeLocalVault(): Promise<{ moved: number; failed: number }> {
    const files = this.app.vault.getFiles();
    let moved = 0;
    let failed = 0;
    for (const file of files) {
      try {
        try {
          if (typeof this.app.fileManager.trashFile === "function") {
            await this.app.fileManager.trashFile(file);
          } else {
            await this.app.vault.trash(file, true);
          }
        } catch {
          await this.app.vault.delete(file, true);
        }
        moved++;
      } catch {
        failed++;
      }
    }
    return { moved, failed };
  }

  async fetchVaultInfo(
    serverUrl: string,
    vaultId: string,
    vaultToken: string
  ): Promise<{ lastUpdate: number; notes: number } | null> {
    try {
      const res = await requestUrl({
        url: `${serverUrl.replace(/\/$/, "")}/v1/vaults/${vaultId}/info?token=${encodeURIComponent(vaultToken)}`,
        method: "GET",
      });
      const body = res.json as { last_update: number; notes: number };
      return { lastUpdate: body.last_update, notes: body.notes };
    } catch {
      return null;
    }
  }

  async fetchVaultNoteIds(): Promise<string[] | null> {
    try {
      const res = await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/v1/vaults/${this.settings.vaultId}/ids?token=${encodeURIComponent(this.settings.vaultToken)}`,
        method: "GET",
      });
      const body = res.json as { note_ids: string[] };
      return body.note_ids;
    } catch {
      return null;
    }
  }

  syncDiagnostic() {
    return this.syncManager?.diagnostic() ?? { localNoteIds: [], pathById: {} };
  }

  attachmentDiagnostic() {
    return this.syncManager?.attachmentDiagnostic() ?? { local: 0, meta: 0 };
  }

  hiddenDiagnostic() {
    return this.syncManager?.hiddenDiagnostic() ?? Promise.resolve({ local: 0, meta: 0 });
  }

  private scanning = false;

  async rescanVault() {
    if (this.scanning) {
      new Notice("Cloud Relay: pemindaian sedang berjalan, tunggu selesai…");
      return;
    }
    this.scanning = true;
    try {
      await this.syncManager?.init(true);
    } finally {
      this.scanning = false;
    }
  }

  async resetServerVault(): Promise<boolean> {
    try {
      await requestUrl({
        url: `${this.settings.serverUrl.replace(/\/$/, "")}/v1/vaults/${this.settings.vaultId}/reset?token=${encodeURIComponent(this.settings.vaultToken)}`,
        method: "POST",
      });
      this.stopSync();
      await this.resetLocalSync();
      if (this.settings.enabled) this.startSync();
      return true;
    } catch (e) {
      new Notice(`Cloud Relay: reset server gagal (${e})`);
      return false;
    }
  }

  async resetLocalSync() {
    await this.syncManager?.reset();
  }

  async testConnection(
    serverUrl: string,
    vaultId: string,
    vaultToken: string
  ): Promise<{ ok: boolean; message: string; notes?: number; lastUpdate?: number }> {
    try {
      const res = await requestUrl({
        url: `${serverUrl.replace(/\/$/, "")}/v1/vaults/${vaultId}/info?token=${encodeURIComponent(vaultToken)}`,
        method: "GET",
      });
      const body = res.json as { last_update: number; notes: number };
      return {
        ok: true,
        message: "Server merespons",
        notes: body.notes,
        lastUpdate: body.last_update,
      };
    } catch (e) {
      return { ok: false, message: `${e}`.slice(0, 120) };
    }
  }

  applyLimits() {
    this.syncManager?.setMaxNoteBytes((this.settings.maxNoteMB || 0) * 1024 * 1024);
    this.syncManager?.setHiddenSyncEnabled(this.settings.hiddenSync !== false);
  }

  async recoverFromServer(): Promise<boolean> {
    if (!this.syncManager) return false;
    new Notice("Cloud Relay: memulihkan data sync dari server…");
    this.stopSync();
    await this.syncManager.reset();
    const files = this.app.vault.getMarkdownFiles();
    this.syncManager.suspend();
    let n = 0;
    for (const file of files) {
      try {
        await this.app.vault.trash(file, true);
        n++;
      } catch {}
    }
    this.syncManager.resumeAfterReset();
    await this.saveSettings();
    this.startSync();
    new Notice(`Cloud Relay: ${n} catatan lokal dikosongkan, menarik ulang dari server…`);
    return true;
  }

  startSync() {
    if (!this.syncManager) return;
    this.syncManager.setHttpTransport({
      baseUrl: this.settings.serverUrl,
      token: this.settings.vaultToken,
    });
    this.applyLimits();
    this.statusBar?.resetStats();
    this.connection = new RelayConnection(
      (status) => this.statusBar?.set(status),
      {
        onDocList: (ids) => {
          this.syncManager?.onDocList(ids);
          void this.syncManager?.initHiddenFiles(false);
          this.onConnectSync();
        },
        onSyncStep1: (id, sv) => this.syncManager?.onSyncStep1(id, sv),
        onSyncStep2: (id, up) => this.syncManager?.onSyncStep2(id, up),
        onUpdate: (id, up) => this.syncManager?.onUpdate(id, up),
        onSent: (n) => this.statusBar?.addSent(n),
        onReceived: (n) => this.statusBar?.addReceived(n),
      }
    );
    this.syncManager.setConn(this.connection);
    this.hiddenWatchStarted = Date.now();
    this.hiddenWatchSeen.clear();
    this.startHiddenWatcher();
    this.connection.connect(
      this.settings.serverUrl,
      this.settings.vaultId,
      this.settings.vaultToken
    );
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(() => {
      if (this.statusBar) {
        this.statusBar.setQueued(this.syncManager?.applyQueueSize() ?? 0);
      }
    }, 500);
  }

  private statsTimer: number | null = null;

  private hiddenWatcherTimer: number | null = null;
  private hiddenWatchSeen = new Map<string, number>();

  private startHiddenWatcher() {
    if (this.hiddenWatcherTimer !== null) return;
    this.hiddenWatcherTimer = window.setInterval(() => {
      void this.pollHiddenFiles();
    }, 5000);
  }

  private async pollHiddenFiles() {
    if (!this.syncManager || !this.settings.hiddenSync) return;
    const prev = this.hiddenWatchSeen;
    const cur = new Map<string, number>();
    try {
      const list = await this.app.vault.adapter.list(".obsidian");
      const allowed = [
        "app.json", "appearance.json", "community-plugins.json",
        "core-plugins.json", "hotkeys.json", "graph.json",
      ];
      for (const f of list.files) {
        const rel = f.replace(/^\.obsidian\//, "");
        if (!rel || rel.startsWith("plugins/cloud-relay/")) continue;
        if (
          !allowed.includes(rel) &&
          !rel.startsWith("themes/") &&
          !rel.startsWith("snippets/")
        )
          continue;
        const st = await this.app.vault.adapter.stat(f);
        if (st?.mtime) cur.set(rel, st.mtime);
      }
    } catch {}
    const firstPoll = !this.hiddenFirstPollDone;
    this.hiddenFirstPollDone = true;
    for (const [rel, mtime] of cur) {
      if (!prev.has(rel) || prev.get(rel) !== mtime) {
        const isNewFile = !prev.has(rel);
        prev.set(rel, mtime);
        // poll pertama = seeding baseline (jangan upload semua); setelah itu,
        // file baru maupun mtime berubah sama-sama dilaporkan
        if (!firstPoll || isNewFile === false) {
          if (!firstPoll) this.syncManager.onHiddenFileChange(rel);
        }
      }
    }
    for (const rel of Array.from(prev.keys())) {
      if (!cur.has(rel)) {
        prev.delete(rel);
        if (!firstPoll) this.syncManager.onHiddenFileChange(rel, true);
      }
    }
  }

  private hiddenWatchStarted = 0;
  private hiddenFirstPollDone = false;

  private stopHiddenWatcher() {
    if (this.hiddenWatcherTimer !== null) {
      window.clearInterval(this.hiddenWatcherTimer);
      this.hiddenWatcherTimer = null;
    }
  }

  stopSync() {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.stopHiddenWatcher();
    this.syncManager?.setConn(null);
    this.connection?.disconnect();
    this.connection = null;
    this.statusBar?.set("disconnected");
  }
}

