import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type CloudRelayPlugin from "../main";
import { buildInviteLink, parseInviteLink } from "../settings";

type Mode = "create" | "join";

function relativeTimeId(unixSecs: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (diff < 60) return "baru saja";
  const min = Math.floor(diff / 60);
  if (min < 60) return `${min} menit lalu`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} jam lalu`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} hari lalu`;
  return new Date(unixSecs * 1000).toLocaleString("id-ID");
}

export class CloudRelaySettingTab extends PluginSettingTab {
  plugin: CloudRelayPlugin;
  private mode: Mode = "create";
  private step = 0;
  private joinLink = "";
  private joinReady: { serverUrl: string; vaultId: string; vaultToken: string } | null = null;
  private joinInfo: { lastUpdate: number; notes: number } | null | "error" = null;
  private showDanger = false;
  private resetArmed = false;
  private disconnectArmed = false;

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
    containerEl.createEl("p", {
      text: `Versi plugin: ${this.plugin.manifest.version}`,
    });

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
    } else if (this.step === 4) {
      this.renderInfoStep(containerEl);
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
    this.plugin.settings.isPrimary = false;
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
        new Notice("Cloud Relay: memeriksa data di server…");
        const info = await this.plugin.fetchVaultInfo(
          parsed.serverUrl,
          parsed.vaultId,
          parsed.vaultToken
        );
        this.joinInfo = info ?? "error";
        this.step = 4;
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

  private renderInfoStep(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Konfirmasi data di server" });

    if (this.joinInfo === "error" || this.joinInfo === null) {
      containerEl.createEl("p", {
        text: "Tidak bisa membaca info dari server. Pastikan server sudah versi terbaru (git pull && docker compose up -d --build) dan bisa diakses.",
        cls: "cloud-relay-warning",
      });
      new Setting(containerEl).addButton((btn) =>
        btn.setButtonText("Tetap lanjut gabung").onClick(() => {
          this.step = this.app.vault.getMarkdownFiles().length > 0 ? 3 : 0;
          if (this.step === 0) void this.finalizeJoin();
          else this.display();
        })
      );
    } else {
      const { lastUpdate, notes } = this.joinInfo;
      containerEl.createEl("p", {
        text: `Catatan di server: ${notes} catatan`,
      });
      containerEl.createEl("p", {
        text: `Terakhir diupdate: ${
          lastUpdate === 0 ? "belum ada data (server masih kosong)" : relativeTimeId(lastUpdate)
        }`,
      });
      containerEl.createEl("p", {
        text: "Cek tanggal update itu — kalau terasa lama, batalkan dulu, lakukan edit kecil di device pertama supaya datanya segar, lalu gabung lagi.",
      });
      new Setting(containerEl)
        .setName("Lanjut gabung")
        .setDesc("Tanggal update sudah oke? Lanjutkan.")
        .addButton((btn) =>
          btn.setButtonText("Lanjut").setCta().onClick(() => {
            if (this.app.vault.getMarkdownFiles().length > 0) {
              this.step = 3;
              this.display();
            } else {
              void this.finalizeJoin();
            }
          })
        );
    }

    this.backButton(containerEl);
  }

  private renderConnected(containerEl: HTMLElement) {
    containerEl.createEl("p", {
      text: `Vault: ${this.app.vault.getName()} — terhubung ke ${this.plugin.settings.serverUrl}`,
    });
    containerEl.createEl("p", {
      text: this.plugin.settings.isPrimary
        ? "★ Device ini: SUMBER PERTAMA (device yang pertama join — kiblat sinkron)"
        : "Device ini: pengikut (mengikuti sumber pertama)",
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
      .setName("Cek sinkronisasi")
      .setDesc("Bandingkan jumlah file di vault, yang terdaftar di sync, dan yang ada di server.")
      .addButton((btn) =>
        btn.setButtonText("Cek sekarang").onClick(async () => {
          new Notice("Cloud Relay: memeriksa…");
          const vaultFiles = this.app.vault.getMarkdownFiles();
          const local = this.plugin.syncDiagnostic();
          const indexedPaths = new Set(Object.values(local.pathById));
          const belumTerdaftar = vaultFiles.filter((f) => !indexedPaths.has(f.path));
          const serverIds = await this.plugin.fetchVaultNoteIds();
          const serverCount = serverIds === null ? "?" : serverIds.length;
          const serverSet = new Set(serverIds ?? []);
          const localSet = new Set(local.localNoteIds);
          const belumTerkirim = local.localNoteIds.filter((id) => !serverSet.has(id));
          const belumDiterima = (serverIds ?? []).filter((id) => !localSet.has(id));
          const sampel = belumTerdaftar
            .slice(0, 3)
            .map((f) => f.path)
            .join(", ");
          new Notice(
            `Cloud Relay — vault: ${vaultFiles.length}, terdaftar: ${local.localNoteIds.length}, server: ${serverCount}, belum terdaftar: ${belumTerdaftar.length}${sampel ? ` (${sampel}…)` : ""}, belum terkirim: ${belumTerkirim.length}, belum diterima: ${belumDiterima.length}`,
            12000
          );
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Pindai ulang vault")
      .setDesc("Daftarkan file yang belum masuk sync (misal setelah update plugin).")
      .addButton((btn) =>
        btn.setButtonText("Pindai").onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Memindai…");
          await this.plugin.rescanVault();
          btn.setDisabled(false);
          btn.setButtonText("Pindai");
          new Notice("Cloud Relay: pemindaian selesai ✓");
        })
      );

    new Setting(containerEl)
      .setName("Opsi berbahaya")
      .setDesc("Tampilkan tombol Reset server & Disconnect. Hanya aktifkan saat benar-benar dibutuhkan.")
      .addToggle((toggle) =>
        toggle.setValue(this.showDanger).onChange((value) => {
          this.showDanger = value;
          this.resetArmed = false;
          this.disconnectArmed = false;
          this.display();
        })
      );

    if (this.showDanger) {
      new Setting(containerEl)
        .setName("Reset server vault")
        .setDesc(
          "Menghapus SEMUA catatan di server untuk vault ini, lalu mengunggah ulang isi vault dari device ini. Setelah ini, device lain HARUS join ulang dengan 'Ikuti device pertama (ganti total)'."
        )
        .addButton((btn) => {
          btn.setButtonText(this.resetArmed ? "YAKIN? Klik lagi untuk reset" : "Reset server");
          btn.setWarning();
          btn.onClick(async () => {
            if (!this.resetArmed) {
              this.resetArmed = true;
              this.display();
              window.setTimeout(() => {
                if (this.resetArmed) {
                  this.resetArmed = false;
                  this.display();
                }
              }, 5000);
              return;
            }
            this.resetArmed = false;
            if (await this.plugin.resetServerVault()) {
              new Notice("Cloud Relay: server di-reset, mengunggah ulang dari device ini…");
            }
            this.display();
          });
        });

      new Setting(containerEl)
        .setName("Putuskan dari server")
        .setDesc("Hapus koneksi di device ini. Catatan lokal tidak dihapus.")
        .addButton((btn) => {
          btn.setButtonText(this.disconnectArmed ? "YAKIN? Klik lagi untuk disconnect" : "Disconnect");
          btn.setWarning();
          btn.onClick(async () => {
            if (!this.disconnectArmed) {
              this.disconnectArmed = true;
              this.display();
              window.setTimeout(() => {
                if (this.disconnectArmed) {
                  this.disconnectArmed = false;
                  this.display();
                }
              }, 5000);
              return;
            }
            this.disconnectArmed = false;
            this.plugin.stopSync();
            this.plugin.settings.vaultId = "";
            this.plugin.settings.vaultToken = "";
            this.plugin.settings.enabled = false;
            await this.plugin.saveSettings();
            this.step = 0;
            this.display();
          });
        });
    }
  }
}
