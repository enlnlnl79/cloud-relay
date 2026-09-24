import {
  decodeFrame,
  encodeFrame,
  MSG_DOC_LIST,
  MSG_PING,
  MSG_PONG,
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
  onSent?: (n: number) => void;
  onReceived?: (n: number) => void;
}

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 15000;
const STALE_THRESHOLD_MS = 35000;
const OUTGOING_BUFFER_MAX = 500;

export class RelayConnection {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private lastMessageAt = 0;
  private closedByUser = false;
  private onStatus: (status: SyncStatus) => void;
  private handlers: ConnectionHandlers;
  private current: { serverUrl: string; vaultId: string; token: string } | null =
    null;
  private outgoing: Uint8Array[] = [];

  constructor(
    onStatus: (status: SyncStatus) => void,
    handlers: ConnectionHandlers
  ) {
    this.onStatus = onStatus;
    this.handlers = handlers;
  }

  connect(serverUrl: string, vaultId: string, token: string) {
    this.closedByUser = false;
    this.current = { serverUrl, vaultId, token };
    this.teardown();
    this.onStatus("connecting");

    const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const url = `${wsUrl}/sync/${vaultId}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    this.lastMessageAt = Date.now();

    ws.onopen = () => {
      // hanya proses kalau socket ini masih yang aktif
      if (this.ws !== ws) return;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.onStatus("synced");
      this.startHeartbeat();
      // flush frame yang tertahan saat CONNECTING
      const pending = this.outgoing;
      this.outgoing = [];
      for (const frame of pending) this.send(frame);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = Date.now();
      this.handlers.onReceived?.(1);
      if (!(event.data instanceof ArrayBuffer)) return;
      const frame = decodeFrame(new Uint8Array(event.data));
      if (!frame) return;
      if (frame.type === MSG_PONG) return;
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

    ws.onclose = () => {
      // abaikan onclose dari socket yang sudah diganti (force-reconnect zombie)
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.ws = null;
      if (this.closedByUser) {
        this.onStatus("disconnected");
      } else {
        this.onStatus("offline");
        this.scheduleReconnect(serverUrl, vaultId, token);
      }
    };

    ws.onerror = () => {};
  }

  disconnect() {
    this.closedByUser = true;
    this.current = null;
    this.teardown();
    this.stopHeartbeat();
    this.onStatus("disconnected");
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = window.setInterval(() => {
      this.send(encodeFrame(MSG_PING, "", new Uint8Array(0)));
    }, PING_INTERVAL_MS);
    this.watchdogTimer = window.setInterval(() => {
      if (Date.now() - this.lastMessageAt > STALE_THRESHOLD_MS) {
        console.warn("cloud-relay: koneksi zombie terdeteksi, reconnect paksa");
        if (this.current) {
          const { serverUrl, vaultId, token } = this.current;
          this.connect(serverUrl, vaultId, token);
        }
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  send(frame: Uint8Array) {
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
      this.handlers.onSent?.(1);
    } else if (ws.readyState === WebSocket.CONNECTING) {
      // tahan frame; akan diflush saat open (update tidak hilang di celah reconnect)
      if (this.outgoing.length < OUTGOING_BUFFER_MAX) {
        this.outgoing.push(frame);
      }
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
