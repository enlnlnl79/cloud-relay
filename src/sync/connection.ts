import {
  decodeFrame,
  encodeFrame,
  MSG_DOC_LIST,
  MSG_SYNC_STEP1,
  MSG_SYNC_STEP2,
  MSG_UPDATE,
  parseDocList,
} from "./protocol";
import { SyncStatus } from "./status";

export interface ConnectionHandlers {
  onDocList: (noteIds: string[]) => void;
  onSyncStep1: (noteId: string, sv: Uint8Array) => void;
  onSyncStep2: (noteId: string, update: Uint8Array) => void;
  onUpdate: (noteId: string, update: Uint8Array) => void;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private onStatus: (status: SyncStatus) => void;
  private handlers: ConnectionHandlers;

  constructor(
    onStatus: (status: SyncStatus) => void,
    handlers: ConnectionHandlers
  ) {
    this.onStatus = onStatus;
    this.handlers = handlers;
  }

  connect(serverUrl: string, vaultId: string, token: string) {
    this.closedByUser = false;
    this.teardown();
    this.onStatus("connecting");

    const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const url = `${wsUrl}/sync/${vaultId}?token=${encodeURIComponent(token)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.onStatus("synced");
    };

    this.ws.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const frame = decodeFrame(new Uint8Array(event.data));
      if (!frame) return;
      switch (frame.type) {
        case MSG_DOC_LIST:
          this.handlers.onDocList(parseDocList(frame.payload));
          break;
        case MSG_SYNC_STEP1:
          this.handlers.onSyncStep1(frame.noteId, frame.payload);
          break;
        case MSG_SYNC_STEP2:
          this.handlers.onSyncStep2(frame.noteId, frame.payload);
          break;
        case MSG_UPDATE:
          this.handlers.onUpdate(frame.noteId, frame.payload);
          break;
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.closedByUser) {
        this.onStatus("disconnected");
      } else {
        this.onStatus("offline");
        this.scheduleReconnect(serverUrl, vaultId, token);
      }
    };

    this.ws.onerror = () => {};
  }

  disconnect() {
    this.closedByUser = true;
    this.teardown();
    this.onStatus("disconnected");
  }

  send(frame: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  private scheduleReconnect(serverUrl: string, vaultId: string, token: string) {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(serverUrl, vaultId, token);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private teardown() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

export { encodeFrame };
