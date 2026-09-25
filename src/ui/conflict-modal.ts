import { App, Modal, Notice } from "obsidian";

export interface ConflictChoice {
  noteId: string;
  path: string;
  local: string;
  remote: string;
  deleted: boolean;
}

export class ConflictModal extends Modal {
  constructor(
    app: App,
    private conflict: ConflictChoice,
    private choose: (choice: "local" | "remote" | "merge") => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Perubahan berbeda ditemukan" });
    contentEl.createEl("p", {
      text: `Catatan "${this.conflict.path}" diubah oleh device ini dan device lain saat offline. Tidak ada versi yang dihapus.`,
    });
    const preview = contentEl.createDiv({ cls: "cloud-relay-conflict-preview" });
    preview.createEl("strong", { text: "Versi device ini" });
    preview.createEl("pre", { text: this.conflict.local.slice(0, 1200) || "(dihapus)" });
    preview.createEl("strong", { text: "Versi device lain" });
    preview.createEl("pre", { text: this.conflict.remote.slice(0, 1200) || "(dihapus)" });

    const actions = contentEl.createDiv({ cls: "cloud-relay-conflict-actions" });
    for (const [label, choice] of [
      ["Pakai versi device ini", "local"],
      ["Pakai versi device lain", "remote"],
      ["Gabungkan kedua versi", "merge"],
    ] as const) {
      const button = actions.createEl("button", { text: label });
      button.addEventListener("click", () => {
        this.choose(choice);
        this.close();
        new Notice("Cloud Relay: pilihan konflik diterapkan");
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
