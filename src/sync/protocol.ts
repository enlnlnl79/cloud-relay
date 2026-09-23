export const MSG_DOC_LIST = 0;
export const MSG_SYNC_STEP1 = 1;
export const MSG_SYNC_STEP2 = 2;
export const MSG_UPDATE = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(
  type: number,
  noteId: string,
  payload: Uint8Array
): Uint8Array {
  const id = encoder.encode(noteId);
  const frame = new Uint8Array(3 + id.length + payload.length);
  frame[0] = type;
  frame[1] = (id.length >> 8) & 0xff;
  frame[2] = id.length & 0xff;
  frame.set(id, 3);
  frame.set(payload, 3 + id.length);
  return frame;
}

export interface Frame {
  type: number;
  noteId: string;
  payload: Uint8Array;
}

export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length < 3) return null;
  const idLen = (data[1] << 8) | data[2];
  if (data.length < 3 + idLen) return null;
  const noteId = decoder.decode(data.subarray(3, 3 + idLen));
  const payload = data.subarray(3 + idLen);
  return { type: data[0], noteId, payload };
}

export function parseDocList(payload: Uint8Array): string[] {
  const ids: string[] = [];
  let i = 0;
  while (i + 2 <= payload.length) {
    const len = (payload[i] << 8) | payload[i + 1];
    i += 2;
    if (i + len > payload.length) break;
    ids.push(decoder.decode(payload.subarray(i, i + len)));
    i += len;
  }
  return ids;
}
