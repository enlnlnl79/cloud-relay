import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CloudRelayPlugin from "../main";
import { buildInviteLink, parseInviteLink } from "../settings";

export class CloudRelaySettingTab extends PluginSettingTab {
  plugin: CloudRelayPlugin;

  constructor(app: App, plugin: CloudRelayPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Cloud Relay" });

    const connected = this.plugin.settings.vaultId !== "";

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Alamat DB Cloud Relay kamu, misal https://dbcloudrelay.enlnlnl79.my.id")
      .addText((text) =>
        text
          .setPlaceholder("https://…")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    if (!connected) {
      new Setting(containerEl)
        .setName("Admin token")
        .setDesc("Token admin dari log server (hanya untuk membuat vault pertama).")
        .addText((text) =>
          text
            .setPlaceholder("fa26d51c…")
            .setValue(this.plugin.settings.adminToken)
            .onChange(async (value) => {
              this.plugin.settings.adminToken = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Buat vault baru")
        .setDesc("Device pertama: daftarkan vault ini ke server.")
        .addButton((btn) =>
          btn
            .setButtonText("Create Vault")
            .setCta()
            .onClick(async () => {
              await this.plugin.createVault();
              this.display();
            })
        );

      new Setting(containerEl)
        .setName("Gabung via invite link")
        .setDesc("Device kedua dan seterusnya: tempel link dari device pertama.")
        .addText((text) =>
          text.setPlaceholder("cloudrelay://join#…").onChange(async (value) => {
            const parsed = parseInviteLink(value.trim());
            if (parsed) {
              this.plugin.settings.serverUrl = parsed.serverUrl;
              this.plugin.settings.vaultId = parsed.vaultId;
              this.plugin.settings.vaultToken = parsed.vaultToken;
              this.plugin.settings.enabled = true;
              await this.plugin.saveSettings();
              new Notice("Cloud Relay: bergabung ke vault ✓");
              this.plugin.startSync();
              this.display();
            }
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Status")
        .setDesc(`Vault: ${this.plugin.settings.vaultId}`);

      new Setting(containerEl)
        .setName("Invite device")
        .setDesc("Salin link ini di device lain untuk bergabung.")
        .addButton((btn) =>
          btn.setButtonText("Salin invite link").onClick(async () => {
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
        .setName("Putuskan dari vault")
        .setDesc("Hapus koneksi vault dari device ini. Data lokal tidak dihapus.")
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
}
