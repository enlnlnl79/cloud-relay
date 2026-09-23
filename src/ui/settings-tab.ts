import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CloudRelayPlugin from "../main";
import { buildInviteLink, parseInviteLink } from "../settings";

type Mode = "create" | "join";

export class CloudRelaySettingTab extends PluginSettingTab {
  plugin: CloudRelayPlugin;
  private mode: Mode = "create";
  private step = 0;
  private joinLink = "";
  private joinReady: { serverUrl: string; vaultId: string; vaultToken: string } | null = null;

  constructor(app: App, plugin: CloudRelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private otherSyncPluginActive(): string | null {
    const app = this.app as unknown as {
      plugins?: { enabledPlugins?: Set<string> };
    };
    const enabled = app.plugins?.enabledPlugins;
    if (enabled?.has("obsidian-livesync")) return "Self-hosted LiveSync";
    if (enabled?.has("remotely-save")) return "Remotely Save";
    return null;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Cloud Relay" });

    const other = this.otherSyncPluginActive();
    if (other) {
      containerEl.createEl("p", {
        text: `⚠️ ${other} terdeteksi aktif di vault ini. Matikan dulu (Settings → Community Plugins) — dua plugin sync berjalan bersamaan akan saling bentrok (file kembali setelah dihapus, note terduplikat).`,
        cls: "cloud-relay-warning",
      });
    }

    if (this.plugin.settings.vaultId) {
      this.renderConnected(containerEl);
      return;
    }

    if (this.step === 0) this.renderRoleStep(containerEl);
    else if (this.step === 1) {
      if (this.mode === "create") this.renderServerStep(containerEl);
      else this.renderJoinStep(containerEl);
    } else if (this.step === 2) {
      this.renderTokenStep(containerEl);
    } else if (this.step === 3) {
      this.renderWarningStep(containerEl);
    }
  }

  private async finalizeJoin() {
    if (!this.joinReady) return;
    const parsed = this.joinReady;
    this.joinReady = null;
    this.plugin.settings.serverUrl = parsed.serverUrl;
    this.plugin.settings.vaultId = parsed.vaultId;
    this.plugin.settings.vaultToken = parsed.vaultToken;
    this.plugin.settings.enabled = true;
    await this.plugin.saveSettings();
    new Notice("Cloud Relay: bergabung ✓ Sinkron dimulai…");
    this.plugin.startSync();
    this.display();
  }

  private backButton(containerEl: HTMLElement) {
    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("← Kembali").onClick(() => {
        if (this.mode === "join" && this.step > 1) this.step = 1;
        else this.step = Math.max(0, this.step - 1);
        this.display();
      })
    );
  }

  private renderRoleStep(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Langkah 1 dari 2 — Peran device ini" });
    containerEl.createEl("p", {
      text: "Vault yang akan disinkronkan: " + this.app.vault.getName(),
    });

    new Setting(containerEl)
      .setName("Device pertama")
      .setDesc("Device ini membuat sync baru di server, lalu membagikan link ke device lain.")
      .addButton((btn) =>
        btn.setButtonText("Pilih").setCta().onClick(() => {
          this.mode = "create";
          this.step = 1;
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Device lain (gabung)")
      .setDesc("Device ini gabung ke sync yang sudah dibuat device pertama, cukup pakai invite link.")
      .addButton((btn) =>
        btn.setButtonText("Pilih").onClick(() => {
          this.mode = "join";
          this.step = 1;
          this.display();
        })
      );
  }

  private renderServerStep(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Langkah 2 dari 3 — Alamat server" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Alamat DB Cloud Relay-mu. Contoh format: https://relay.domainkamu.com (tanpa garis miring di akhir).")
      .addText((text) =>
        text
          .setPlaceholder("https://relay.domainkamu.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Lanjut →").setCta().onClick(() => {
        if (!this.plugin.settings.serverUrl) {
          new Notice("Cloud Relay: isi Server URL dulu.");
          return;
        }
        this.step = 2;
        this.display();
      })
    );

    this.backButton(containerEl);
  }

  private renderTokenStep(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Langkah 3 dari 3 — Kunci server" });
    containerEl.createEl("p", {
      text: `Vault yang akan disinkronkan: ${this.app.vault.getName()} → ${this.plugin.settings.serverUrl}`,
    });

    new Setting(containerEl)
      .setName("Admin token")
      .setDesc(
        "Kunci admin server, dicetak sekali di log server: docker compose logs | grep 'admin token'. Hanya dibutuhkan device pertama."
      )
      .addText((text) =>
        text
          .setPlaceholder("tempel token dari log server")
          .setValue(this.plugin.settings.adminToken)
          .onChange(async (value) => {
            this.plugin.settings.adminToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Buat sync vault")
      .setDesc("Daftarkan vault ini ke server. Setelah berhasil, akan muncul link untuk device lain.")
      .addButton((btn) =>
        btn.setButtonText("Buat sekarang").setCta().onClick(async () => {
          if (await this.plugin.createVault()) this.display();
        })
      );

    this.backButton(containerEl);
  }

  private renderJoinStep(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Langkah 2 dari 2 — Invite link" });
    containerEl.createEl("p", {
      text: "Vault yang akan disinkronkan: " + this.app.vault.getName(),
    });

    new Setting(containerEl)
      .setName("Invite link")
      .setDesc("Tempel invite link dari device pertama (di device pertama: tombol 'Copy invite link').")
      .addText((text) =>
        text
          .setPlaceholder("cloudrelay://join#…")
          .setValue(this.joinLink)
          .onChange((value) => {
            this.joinLink = value.trim();
          })
      );

    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Gabung").setCta().onClick(async () => {
        const parsed = parseInviteLink(this.joinLink);
        if (!parsed) {
          new Notice("Cloud Relay: link tidak valid. Pastikan diawali cloudrelay://join#");
          return;
        }
        this.joinReady = parsed;
        if (this.app.vault.getMarkdownFiles().length === 0) {
          await this.finalizeJoin();
          return;
        }
        this.step = 3;
        this.display();
      })
    );

    this.backButton(containerEl);
  }

  private renderWarningStep(containerEl: HTMLElement) {
    const count = this.app.vault.getMarkdownFiles().length;
    containerEl.createEl("h3", { text: "Peringatan — vault ini tidak kosong" });
    containerEl.createEl("p", {
      text: `Vault "${this.app.vault.getName()}" berisi ${count} catatan. Pilih cara menyesuaikan dengan vault device pertama.`,
    });
    containerEl.createEl("p", {
      text: "⚠️ Opsi 'Ikuti device pertama' akan MENGOSONGKAN vault ini lalu mengisinya dari device pertama. Backup manual dulu kalau ada catatan penting di sini (misal copy folder vault lewat aplikasi Files / Finder).",
    });

    new Setting(containerEl)
      .setName("Ikuti device pertama (ganti total)")
      .setDesc(
        "Vault ini dikosongkan, lalu diisi ulang persis mengikuti device pertama. Pastikan sudah backup manual — catatan di sini akan hilang dari vault ini. Jika device ini pernah gabung sebelumnya, minta device pertama menekan 'Reset server vault' dulu supaya catatan lama tidak ikut kembali dari server."
      )
      .addButton((btn) =>
        btn.setButtonText("Kosongkan & ikuti").setCta().onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Memproses…");
        try {
          new Notice(`Cloud Relay: mengosongkan ${count} catatan…`);
          const { moved, failed } = await this.plugin.wipeLocalVault();
          await this.plugin.resetLocalSync();
          if (failed > 0) {
            new Notice(`Cloud Relay: ${moved} dikosongkan, ${failed} GAGAL (${failed} file masih di vault)`);
          } else {
            new Notice(`Cloud Relay: ${moved} catatan dikosongkan ✓ Sinkron dimulai…`);
          }
          await this.finalizeJoin();
        } catch (e) {
            new Notice(`Cloud Relay: gagal — ${e}`);
            btn.setDisabled(false);
            btn.setButtonText("Kosongkan & ikuti");
          }
        })
      );

    new Setting(containerEl)
      .setName("Gabungkan")
      .setDesc(
        "Catatan lokal ikut tersinkron ke device lain (merge). File yang namanya sama tapi isinya beda diselamatkan dua-duanya: versi device lain dinamai '… (konflik dari device lain).md'."
      )
      .addButton((btn) =>
        btn.setButtonText("Gabungkan").onClick(async () => {
          await this.finalizeJoin();
        })
      );

    this.backButton(containerEl);
  }

  private renderConnected(containerEl: HTMLElement) {
    containerEl.createEl("p", {
      text: `Vault: ${this.app.vault.getName()} — terhubung ke ${this.plugin.settings.serverUrl}`,
    });

    new Setting(containerEl)
      .setName("Bagikan link ke device lain")
      .setDesc("Copy link ini, lalu tempel di plugin Cloud Relay pada device lain (pilih 'Device lain (gabung)').")
      .addButton((btn) =>
        btn.setButtonText("Copy invite link").setCta().onClick(async () => {
          await navigator.clipboard.writeText(buildInviteLink(this.plugin.settings));
          new Notice("Cloud Relay: invite link tersalin ✓");
        })
      );

    new Setting(containerEl)
      .setName("Sinkronisasi")
      .setDesc(this.plugin.settings.enabled ? "Aktif" : "Nonaktif")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          if (value) this.plugin.startSync();
          else this.plugin.stopSync();
        })
      );

    new Setting(containerEl)
      .setName("Reset server vault")
      .setDesc(
        "Menghapus SEMUA catatan di server untuk vault ini, lalu mengunggah ulang isi vault dari device ini. Setelah ini, device lain HARUS join ulang dengan 'Ikuti device pertama (ganti total)'. Gunakan ini bila device lain pernah gabung dengan isi yang salah."
      )
      .addButton((btn) =>
        btn.setButtonText("Reset server").setWarning().onClick(async () => {
          if (await this.plugin.resetServerVault()) {
            new Notice("Cloud Relay: server di-reset, mengunggah ulang dari device ini…");
          }
        })
      );

    new Setting(containerEl)
      .setName("Putuskan dari server")
      .setDesc("Hapus koneksi di device ini. Catatan lokal tidak dihapus.")
      .addButton((btn) =>
        btn.setButtonText("Disconnect").setWarning().onClick(async () => {
          this.plugin.stopSync();
          this.plugin.settings.vaultId = "";
          this.plugin.settings.vaultToken = "";
          this.plugin.settings.enabled = false;
          await this.plugin.saveSettings();
          this.step = 0;
          this.display();
        })
      );
  }
}
