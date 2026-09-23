export type SyncStatus = "disconnected" | "connecting" | "synced" | "syncing" | "offline";

export class StatusBar {
  private el: HTMLElement;
  private status: SyncStatus = "disconnected";

  constructor(el: HTMLElement) {
    this.el = el;
    this.render();
  }

  set(status: SyncStatus) {
    this.status = status;
    this.render();
  }

  get(): SyncStatus {
    return this.status;
  }

  private render() {
    const map: Record<SyncStatus, string> = {
      disconnected: "Cloud Relay: —",
      connecting: "Cloud Relay: …",
      synced: "Cloud Relay: ●",
      syncing: "Cloud Relay: ↻",
      offline: "Cloud Relay: ✕",
    };
    this.el.setText(map[this.status]);
    this.el.dataset.status = this.status;
  }
}
