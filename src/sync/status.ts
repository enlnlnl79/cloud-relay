import { Notice } from "obsidian";

export type SyncStatus = "disconnected" | "connecting" | "synced" | "syncing" | "offline";

export interface SyncStats {
  sent: number;
  received: number;
  queued: number;
}

export class StatusBar {
  private el: HTMLElement;
  private status: SyncStatus = "disconnected";
  private stats: SyncStats = { sent: 0, received: 0, queued: 0 };
  private renderTimer: number | null = null;
  private dirty = false;

  constructor(el: HTMLElement) {
    this.el = el;
    this.render();
  }

  set(status: SyncStatus) {
    if (status === "synced" && this.stats.queued > 0) status = "syncing";
    this.status = status;
    this.render();
  }

  get(): SyncStatus {
    return this.status;
  }

  addSent(n = 1) {
    this.stats.sent += n;
    this.scheduleRender();
  }

  addReceived(n = 1) {
    this.stats.received += n;
    this.scheduleRender();
  }

  setQueued(n: number) {
    if (this.stats.queued === 0 && n > 0 && this.status === "synced") {
      this.status = "syncing";
    }
    this.stats.queued = n;
    this.scheduleRender();
  }

  resetStats() {
    this.stats = { sent: 0, received: 0, queued: 0 };
    this.render();
  }

  busy(): boolean {
    return this.stats.queued > 0;
  }

  warnIfBusy() {
    if (this.busy()) {
      new Notice(
        `Cloud Relay: masih ada ${this.stats.queued} item di antrian — tunggu selesai sebelum menutup Obsidian`
      );
    }
  }

  // throttle: saat pull besar, onmessage bisa ratusan/detik — render max 10x/detik
  private scheduleRender() {
    this.dirty = true;
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.dirty) this.render();
    }, 100);
  }

  private render() {
    this.dirty = false;
    const icon: Record<SyncStatus, string> = {
      disconnected: "○",
      connecting: "…",
      synced: "●",
      syncing: "↻",
      offline: "✕",
    };
    let text = `Cloud Relay ${icon[this.status]}`;
    const parts: string[] = [];
    if (this.stats.sent > 0) parts.push(`↑${this.stats.sent}`);
    if (this.stats.received > 0) parts.push(`↓${this.stats.received}`);
    if (this.stats.queued > 0) parts.push(`⚙${this.stats.queued}`);
    if (parts.length > 0) text += ` ${parts.join(" ")}`;
    this.el.setText(text);
    this.el.dataset.status = this.status;
    this.el.setAttribute(
      "aria-label",
      `Cloud Relay: ${this.status}, terkirim ${this.stats.sent}, diterima ${this.stats.received}`
    );
  }
}
