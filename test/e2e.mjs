// E2E DUA-DEVICE NYATA: 2x NoteSyncManager (plugin asli) <--> WS <--> server nyata.
// Menguji: join, live edit, offline edit + merge, delete lintas-device,
// rename, lampiran, hidden file, reconnect, duplex protocol.
// Jalankan: node test/e2e.mjs  (server harus jalan di :18099)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("./entry.bundle.cjs");
const assert = require("assert");
const Y = M.Y ?? require("yjs");

const {
  NoteSyncManager,
  TFile,
  MockVault,
} = M;

const BASE = process.env.RELAY_URL ?? "http://localhost:18099";
const ADMIN = process.env.RELAY_ADMIN ?? "";

globalThis.window = globalThis;

// ---------- RelayConnection asli (dari src) ----------
const Conn = require("./entry.bundle.cjs").RelayConnection;
if (!Conn) throw new Error("RelayConnection tidak terekspor");

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}\n      ${e.message.split("\n")[0]}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(ms = 700) { await sleep(ms); }

// ---------- mock WS <-> Node WebSocket bridge ----------
// Node 22 punya WebSocket global (undici). RelayConnection pakai window.WebSocket.
globalThis.WebSocket = WebSocket;

// fetch mock: /v1/blobs ke server nyata? — kita proxy ke server NYATA agar E2E penuh:
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.includes("/v1/blobs/")) {
    return realFetch(`${BASE}${u.slice(u.indexOf("/v1/"))}`, init);
  }
  return realFetch(url, init);
};

// mock requestUrl tidak dipakai di sini (manager tidak memakai requestUrl)

// ---------- store on-disk (folder tmp per device) ----------
import fs from "fs";
import path from "path";
import os from "os";
function makeDiskStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return {
    async ensureDir() {},
    async readBlob(id) {
      const p = path.join(dir, id + ".bin");
      return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
    },
    async writeBlob(id, data) {
      fs.writeFileSync(path.join(dir, id + ".bin"), data);
    },
    async readSv(id) {
      const p = path.join(dir, id + ".sv");
      return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
    },
    async writeSv() {},
    async readIndex() {
      const p = path.join(dir, "index.json");
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    },
    async writeIndex(idx) {
      fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(idx, null, 2));
    },
    async readAttachSeen() {
      const p = path.join(dir, "attach-seen.json");
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    },
    async writeAttachSeen(s) {
      fs.writeFileSync(path.join(dir, "attach-seen.json"), JSON.stringify(s, null, 2));
    },
    async readHiddenSeen() {
      const p = path.join(dir, "hidden-seen.json");
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
    },
    async writeHiddenSeen(s) {
      fs.writeFileSync(path.join(dir, "hidden-seen.json"), JSON.stringify(s, null, 2));
    },
    async archive() {},
  };
}

// ---------- device = manager + vault + conn nyata ----------
function makeDevice(tag) {
  const dev = makeDeviceInner(tag);
  dev.sentCount = 0;
  const origSend = dev.conn.send.bind(dev.conn);
  dev.conn.send = (f) => { dev.sentCount++; origSend(f); };
  return dev;
}

function makeDeviceInner(tag) {
  const vault = new MockVault();
  const store = makeDiskStore(path.join(os.tmpdir(), `relay-e2e-${tag}-${Date.now()}`));
  const app = { vault, fileManager: {} };
  const manager = new NoteSyncManager(app, vault, store);
  // wiring event PERSIS main.ts registerVaultEvents
  vault.on("create", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") {
        vault.read(file).then((c) => manager.onFileCreate(file, c));
      } else {
        manager.onAttachmentChange(file);
      }
    }
  });
  vault.on("modify", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") {
        vault.read(file).then((c) => manager.onFileModify(file, c));
      } else {
        manager.onAttachmentChange(file);
      }
    }
  });
  vault.on("delete", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") manager.onFileDelete(file);
      else manager.onAttachmentChange(file, true);
    }
  });
  vault.on("rename", (file, oldPath) => {
    if (file instanceof TFile) {
      if (file.extension === "md") manager.onFileRename(file, oldPath);
      else manager.onAttachmentChange(file, false, oldPath);
    }
  });
  const conn = new Conn(
    () => {},
    {
      onDocList: (ids) => void manager.onDocList(ids),
      onSyncStep1: (id, sv) => void manager.onSyncStep1(id, sv),
      onSyncStep2: (id, up) => void manager.onSyncStep2(id, up),
      onUpdate: (id, up) => void manager.onUpdate(id, up),
    }
  );
  manager.setConn(conn);
  manager.setHttpTransport({ baseUrl: BASE, token: "" });
  return { tag, vault, store, manager, conn };
}

// helper: tunggu kondisi dengan timeout
async function waitFor(desc, fn, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout menunggu: ${desc}`);
}

(async () => {
  console.log("\n=== SETUP: buat vault di server nyata ===");
  const resp = await realFetch(`${BASE}/v1/vaults`, {
    method: "POST",
    headers: { "x-admin-token": ADMIN },
  });
  assert.equal(resp.status, 200, "create vault");
  const { vault_id: VID, token: VTOK } = await resp.json();
  console.log(`vault: ${VID}`);
  assert.ok(VID && VTOK);

  // ============================================================
  console.log("\n=== E2E 1: join dua device, file A sampai ke B ===");
  const A = makeDevice("A");
  const B = makeDevice("B");
  A.manager.setHttpTransport({ baseUrl: BASE, token: VTOK });
  B.manager.setHttpTransport({ baseUrl: BASE, token: VTOK });

  A.vault.fsWrite("catatan/berbagi.md", "isi awal dari A");
  await A.manager.init();
  await A.conn.connect(BASE, VID, VTOK);
  await waitFor("A connect", () => true, 1500);
  await A.manager.sendSyncSteps(A.conn);
  await waitFor("catatan A sampai ke server", async () => {
    const r = await realFetch(`${BASE}/v1/vaults/${VID}/info?token=${VTOK}`);
    const j = await r.json();
    return j.notes >= 1;
  });

  await B.manager.init();
  await B.conn.connect(BASE, VID, VTOK);
  await waitFor("B connect", () => true, 1500);
  await settle(1500);

  await test("B menerima catatan A (path + isi)", async () => {
    const f = B.vault.getAbstractFileByPath("catatan/berbagi.md");
    assert.ok(f, "file harus ada di vault B");
    const content = new TextDecoder().decode(
      B.vault.adapter.files.get("catatan/berbagi.md").data
    );
    assert.equal(content, "isi awal dari A");
  });

  // ============================================================
  console.log("\n=== E2E 2: live edit A -> B (per kata) ===");
  await test("edit A terlihat di B", async () => {
    A.vault.fsWrite("catatan/berbagi.md", "isi awal dari A + tambahan");
    const f = A.vault.getAbstractFileByPath("catatan/berbagi.md");
    A.manager.onFileModify(f, "isi awal dari A + tambahan");
    await waitFor("isi baru sampai B", () => {
      const d = B.vault.adapter.files.get("catatan/berbagi.md");
      return d && new TextDecoder().decode(d.data) === "isi awal dari A + tambahan";
    });
  });

  // ============================================================
  console.log("\n=== E2E 3: offline B edit -> merge tanpa duplikasi ===");
  await test("B offline edit, A online edit bagian lain, merge bersih", async () => {
    B.conn.disconnect(); // B offline
    await settle(300);

    const textB = "isi awal dari A + tambahan";
    const newB = textB + "\n\nbaris tambahan dari B (offline)";
    B.vault.fsWrite("catatan/berbagi.md", newB);
    B.manager.onFileModify(
      B.vault.getAbstractFileByberbagi?.() ?? B.vault.getAbstractFileByPath("catatan/berbagi.md"),
      newB
    );

    // A mengedit juga (bagian berbeda)
    const newA = "isi awal dari A + tambahan\n\ntambahan dari A (saat B offline)";
    A.vault.fsWrite("catatan/berbagi.md", newA);
    A.manager.onFileModify(
      A.vault.getAbstractFileByPath("catatan/berbagi.md"),
      newA
    );
    await settle(800);

    // B kembali online
    await B.conn.connect(BASE, VID, VTOK);
    await B.manager.sendSyncSteps(B.conn);
    await settle(2500);

    const finalA = new TextDecoder().decode(
      A.vault.adapter.files.get("catatan/berbagi.md").data
    );
    const finalB = new TextDecoder().decode(
      B.vault.adapter.files.get("catatan/berbagi.md").data
    );
    // konvergensi: keduanya identik
    assert.equal(finalA, finalB, "A dan B harus konvergen");
    // tanpa duplikasi: kata unik masing-masing muncul tepat 1x
    assert.equal(finalA.split("tambahan dari A (saat B offline)").length - 1, 1, "teks A 1x");
    assert.equal(finalA.split("baris tambahan dari B (offline)").length - 1, 1, "teks B 1x");
  });

  // ============================================================
  console.log("\n=== E2E 4: delete di A -> hilang di B ===");
  await test("delete lintas-device", async () => {
    A.vault.fsWrite("hapus-saya.md", "akan dihapus");
    const f = A.vault.getAbstractFileByPath("hapus-saya.md");
    A.manager.onFileCreate(f, "akan dihapus");
    const t = await waitFor("file sampai B", () => B.vault.adapter.files.has("hapus-saya.md"), 6000).then(() => true).catch(() => false);

    const fa = A.vault.getAbstractFileByPath("hapus-saya.md");
    await A.vault.delete(fa);
    A.manager.onFileDelete(new TFile("hapus-saya.md", { mtime: Date.now(), size: 0 }));
    await waitFor("file hilang di B", () => !B.vault.adapter.files.has("hapus-saya.md"));
    await settle(600);
    assert.ok(!B.vault.adapter.files.has("hapus-saya.md"), "tetap hilang");
  });

  // ============================================================
  console.log("\n=== E2E 5: rename di A -> ikut di B ===");
  await test("rename lintas-device", async () => {
    A.vault.fsWrite("nama-lama.md", "isi rename");
    A.manager.onFileCreate(
      A.vault.getAbstractFileByPath("nama-lama.md"),
      "isi rename"
    );
    await waitFor("nama-lama sampai B", () =>
      B.vault.adapter.files.has("nama-lama.md")
    );

    const fa = A.vault.getAbstractFileByPath("nama-lama.md");
    await A.vault.rename(fa, "nama-baru.md");
    await waitFor("nama-baru muncul di B", () =>
      B.vault.adapter.files.has("nama-baru.md")
    );
    assert.ok(!B.vault.adapter.files.has("nama-lama.md"), "nama lama hilang di B");
    const isi = new TextDecoder().decode(
      B.vault.adapter.files.get("nama-baru.md").data
    );
    assert.equal(isi, "isi rename");
  });

  // ============================================================
  console.log("\n=== E2E 6: lampiran sync A -> B (blob server nyata) ===");
  await test("attachment terkirim & diterima", async () => {
    A.vault.fsWriteBinary("img/foto.png", new Uint8Array([10, 20, 30, 40]));
    await A.manager.initAttachments();
    await settle(500);
    // B harus menariknya saat reconcile
    await B.manager.initAttachments();
    await settle(1500);
    assert.ok(
      B.vault.adapter.files.has("img/foto.png"),
      "lampiran harus sampai ke B"
    );
    const dataB = B.vault.adapter.files.get("img/foto.png").data;
    assert.deepEqual(Array.from(dataB), [10, 20, 30, 40]);
  });

  // ============================================================
  console.log("\n=== E2E 7: konvergensi blob .obsidian (hidden) ===");
  await test("hidden file A terkirim, B menarik", async () => {
    A.manager.setHiddenSyncEnabled(true);
    B.manager.setHiddenSyncEnabled(true);
    A.vault.adapter.files.set(".obsidian/app.json", {
      data: new TextEncoder().encode('{"tes":1}'),
      mtime: Date.now(),
    });
    await A.manager.initHiddenFiles();
    await waitFor("update hidden sampai ke B", async () => {
      const hd = await B.manager.hiddenDiagnostic();
      return hd.meta >= 1;
    }, 6000).catch(() => {
      // B belum dapat broadcast — dorong dengan sync step penuh
      return B.manager.sendSyncSteps(B.conn);
    });
    await settle(1500);
    const hd = await B.manager.hiddenDiagnostic();
    assert.ok(hd.meta >= 1, `map hidden B terisi (meta=${hd.meta})`);
    assert.ok(
      B.vault.adapter.files.has(".obsidian/app.json"),
      "file .obsidian/app.json tertulis di B"
    );
  });

  // ============================================================
  console.log(`\n=== HASIL E2E: ${passed} lulus, ${failed} gagal ===`);
  A.conn.disconnect();
  B.conn.disconnect();
  if (failed > 0) {
    console.log("\nDetail:");
    for (const f of failures) {
      console.log(`\n--- ${f.name} ---`);
      console.log(f.error.stack ?? f.error.message);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
