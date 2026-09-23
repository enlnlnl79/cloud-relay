import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CloudRelayPlugin from "../main";
import { buildInviteLink, parseInviteLink } from "../settings";

type Mode = "create" | "join";

export class CloudRelaySettingTab extends PluginSettingTab {
  plugin: CloudRelayPlugin;
  private mode: Mode = "create";
  private joinLink = "";

  constructor(app: App, plugin: CloudRelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Cloud Relay" });

    if (this.plugin.settings.vaultId) {
      this.renderConnected(containerEl);
      return;
    }

    this.renderSetup(containerEl);
  }

  private renderSetup(containerEl: HTMLElement) {
    containerEl.createEl("p", {
      text: "Setup device ini. Pilih salah satu — device pertama membuat sync baru, device berikutnya gabung pakai link.",
    });

    new Setting(containerEl)
      .setName("Peran device ini")
      .setDesc(
        this.mode === "create"
          ? "Device pertama: membuat sync baru di server, lalu membagikan link ke device lain."
          : "Device lain: gabung ke sync yang sudah dibuat device pertama."
      )
      .addButton((btn) => {
        btn.setButtonText("Device pertama");
        if (this.mode === "create") btn.setCta().setDisabled(true);
        btn.onClick(() => {
          this.mode = "create";
          this.display();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("Device lain (gabung)");
        if (this.mode === "join") btn.setCta().setDisabled(true);
        btn.onClick(() => {
          this.mode = "join";
          this.display();
        });
      });

    if (this.mode === "create") this.renderCreate(containerEl);
    else this.renderJoin(containerEl);
  }

  private renderCreate(containerEl: HTMLElement) {
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

    new Setting(containerEl)
      .setName("Admin token")
      .setDesc(
        "Kunci admin server, dicetak sekali di log server saat pertama kali dijalankan: `docker compose logs | grep token`. Dipakai HANYA di device pertama untuk membuat vault, tidak perlu di device lain."
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
      .setDesc("Daftarkan vault Obsidian ini ke server sebagai sync baru.")
      .addButton((btn) =>
        btn
          .setButtonText("Buat sekarang")
          .setCta()
          .onClick(async () => {
            await this.plugin.createVault();
            this.display();
          })
      );
  }

  private renderJoin(containerEl: HTMLElement) {
    new Setting(containerEl)
      .setName("Invite link")
      .setDesc("Tempel invite link dari device pertama (device pertama: tombol 'Bagikan link ke device lain').")
      .addText((text) =>
        text
          .setPlaceholder("cloudrelay://join#…")
          .setValue(this.joinLink)
          .onChange((value) => {
            this.joinLink = value.trim();
          })
      );

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Gabung")
        .setCta()
        .onClick(async () => {
          const parsed = parseInviteLink(this.joinLink);
          if (!parsed) {
            new Notice("Cloud Relay: link tidak valid. Pastikan diawali cloudrelay://join#");
            return;
          }
          this.plugin.settings.serverUrl = parsed.serverUrl;
          this.plugin.settings.vaultId = parsed.vaultId;
          this.plugin.settings.vaultToken = parsed.vaultToken;
          this.plugin.settings.enabled = true;
          await this.plugin.saveSettings();
          new Notice("Cloud Relay: bergabung ✓");
          this.plugin.startSync();
          this.display();
        })
    );
  }

  private renderConnected(containerEl: HTMLElement) {
    containerEl.createEl("p", {
      text: `Terhubung ke server: ${this.plugin.settings.serverUrl}`,
    });
    containerEl.createEl("p", {
      text: `ID vault: ${this.plugin.settings.vaultId}`,
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
      .setName("Putuskan dari server")
      .setDesc("Hapus koneksi di device ini. Catatan lokal tidak dihapus.")
      .addButton((btn) =>
        btn
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            this.plugin.stopSync();
            this.plugin.settings.vaultId = "";
            this.plugin.settings.vaultToken = "";
            this.plugin.settings.enabled = false;
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }
}
