// Entry untuk test bundle: meng-ekspor modul nyata + mock obsidian
// supaya test bisa require satu file CJS.
import { NoteSyncManager, isSyncablePath } from "../src/sync/note-sync";
import { encodeFrame, decodeFrame, parseDocList } from "../src/sync/protocol";
import { parseInviteLink, buildInviteLink } from "../src/settings";
import { TFile, Notice, Plugin } from "./obsidian-mock";

export {
  NoteSyncManager,
  isSyncablePath,
  encodeFrame,
  decodeFrame,
  parseDocList,
  parseInviteLink,
  buildInviteLink,
  TFile,
  Notice,
  Plugin,
};
export { diffText } from "../src/sync/note-sync";
export { MockVault, MockAdapter } from "./mock-vault";
