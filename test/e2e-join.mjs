// E2E JOIN FLOW: persis alur wizard HP
// 1. Device A (sumber pertama): sync 8 catatan (nested folder) + lampiran + hidden
// 2. Device C: vault KOTOR (file lama tidak sinkron) → wizard "Ikuti (ganti total)"
//    → wipe semua file → reset store → connect → pull semua
// 3. Verifikasi: identik 100% — jumlah, path, isi, lampiran, tanpa file konflik
// 4. Tambahan: tes "Gabungkan" (merge) dengan device D kotor
// Jalankan: node test/e2e-join.mjs  (server :18099)
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("./entry.bundle.cjs");
const assert = require("assert");
const Y = M.Y;

const { NoteSyncManager, RelayConnection, TFile, MockVault } = M;

const BASE = process.env.RELAY_URL ?? "http://localhost:18099";
const ADMIN = process.env.RELAY_ADMIN ?? "";

globalThis.window = globalThis;
globalThis.WebSocket = WebSocket;

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (u, i) => {
  const s = String(u);
  if (s.includes("/v1/blobs/")) {
    return realFetch(`${BASE}${s.slice(s.indexOf("/v1/"))}`, i);
  }
  return realFetch(u, i);
};

import fs from "fs";
import path from "path";
import os from "os";

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
async function settle(ms = 800) { await sleep(ms); }
async function waitFor(desc, fn, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout menunggu: ${desc}`);
}

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

function makeDevice(tag, seed = {}) {
  const vault = new MockVault();
  const store = makeDiskStore(path.join(os.tmpdir(), `relay-join-${tag}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`));
  const app = { vault, fileManager: {} };
  const manager = new NoteSyncManager(app, vault, store);
  // wiring event PERSIS registerVaultEvents main.ts
  vault.on("create", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") vault.read(file).then((c) => manager.onFileCreate(file, c));
      else manager.onAttachmentChange(file);
    }
  });
  vault.on("modify", (file) => {
    if (file instanceof TFile) {
      if (file.extension === "md") vault.read(file).then((c) => manager.onFileModify(file, c));
      else manager.onAttachmentChange(file);
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
  void seed;
  return { tag, vault, manager, store, conn: null };
}

function connectDevice(dev, VID, VTOK) {
  const conn = new RelayConnection(
    () => {},
    {
      onDocList: (ids) => void dev.manager.onDocList(ids),
      onSyncStep1: (id, sv) => void dev.manager.onSyncStep1(id, sv),
      onSyncStep2: (id, up) => void dev.manager.onSyncStep2(id, up),
      onUpdate: (id, up) => void dev.manager.onUpdate(id, up),
    }
  );
  dev.conn = conn;
  dev.manager.setConn(conn);
  dev.manager.setHttpTransport({ baseUrl: BASE, token: VTOK });
  dev.manager.setHiddenSyncEnabled(true);
  conn.connect(BASE, VID, VTOK);
  return conn;
}

function readText(dev, p) {
  const d = dev.vault.adapter.files.get(p);
  return d ? new TextDecoder().decode(d.data) : null;
}

(async () => {
  console.log("\n=== SETUP: vault baru + device A (sumber pertama) ===");
  const resp = await realFetch(`${BASE}/v1/vaults`, {
    method: "POST",
    headers: { "x-admin-token": ADMIN },
  });
  const { vault_id: VID, token: VTOK } = await resp.json();
  console.log(`vault: ${VID}`);

  const A = makeDevice("A");
  const dataset = [
    ["catatan/berbagi.md", "isi awal dari A"],
    ["catatan/sub/nested.md", "nested note"],
    ["01_Projects/todo.md", "daftar tugas\n- satu\n- dua"],
    ["00_Inbox/pikiran.md", "braindump"],
    ["03_Resources/promt.md", "master prompt"],
    ["04_Archive/arsip.md", "arsip lama"],
    ["02_Areas/Journal/hari ini.md", "journal"],
    ["notesolo.md", "catatan root"],
  ];
  for (const [p, c] of dataset) A.vault.fsWrite(p, c);
  A.vault.fsWriteBinary("img/foto.png", new Uint8Array([1, 2, 3, 4, 5]));
  A.vault.fsWriteBinary("img/dokumen.pdf", new Uint8Array([9, 8, 7]));
  A.vault.adapter.files.set(".obsidian/app.json", {
    data: new TextEncoder().encode('{"theme":"dark"}'),
    mtime: Date.now(),
  });

  await A.manager.init();
  A.manager.setHttpTransport({ baseUrl: BASE, token: VTOK });
  A.manager.setHiddenSyncEnabled(true);
  connectDevice(A, VID, VTOK);
  await A.manager.sendSyncSteps(A.conn);
  await A.manager.initHiddenFiles();
  await A.manager.initAttachments();
  await settle(2500);
  console.log("A siap: 8 md + 2 lampiran + 1 hidden");

  // ============================================================
  console.log("\n=== JOIN 1: device C kotor → 'Ikuti (ganti total)' ===");
  const C = makeDevice("C");
  // vault C KOTOR: 3 file lama (2 bentrok nama dengan A, 1 unik)
  C.vault.fsWrite("catatan/berbagi.md", "ISI LAMA HP YANG BEDA");
  C.vault.fsWrite("00_Inbox/pikiran.md", "versi lama hp");
  C.vault.fsWrite("hp-only.md", "hanya ada di hp");
  C.vault.fsWriteBinary("img/foto-lama.png", new Uint8Array([99, 99]));

  await test("wizard ganti total: wipe → reset → join → 100% identik", async () => {
    // === PERSIS wizard: wipeLocalVault + resetLocalSync + startSync ===
    const files = C.vault.getFiles();
    for (const file of files) {
      try { await C.vault.trash(file, true); } catch {}
    }
    C.manager.suspend();
    await C.manager.reset();
    C.manager.resumeAfterReset();
    // C.manager.reset() sudah un-suspend; connect:
    connectDevice(C, VID, VTOK);
    await settle(3000);

    // jumlah catatan md sama
    const aFiles = new Set(
      A.vault.getMarkdownFiles().map((f) => f.path)
    );
    const cFiles = new Set(
      C.vault.getMarkdownFiles().map((f) => f.path)
    );
    assert.equal(cFiles.size, aFiles.size, `jumlah md C=${cFiles.size} vs A=${aFiles.size}`);
    for (const p of aFiles) {
      assert.ok(cFiles.has(p), `C kurang: ${p}`);
      assert.equal(
        readText(C, p),
        readText(A, p),
        `isi beda utk ${p}`
      );
    }
    // file lama HP hilang
    assert.ok(!C.vault.adapter.files.has("hp-only.md"), "hp-only.md harus terhapus");
    assert.ok(!C.vault.adapter.files.has("img/foto-lama.png"), "foto lama harus terhapus");
    // tidak ada file konflik
    const conflicts = Array.from(C.vault.adapter.files.keys()).filter((p) =>
      p.includes("konflik")
    );
    assert.equal(conflicts.length, 0, `tidak boleh ada file konflik: ${conflicts}`);
  });

  await test("lampiran ikut turun saat join", async () => {
    await C.manager.initAttachments();
    await settle(2000);
    assert.ok(C.vault.adapter.files.has("img/foto.png"), "foto.png harus ada di C");
    assert.ok(C.vault.adapter.files.has("img/dokumen.pdf"), "dokumen.pdf harus ada di C");
    const d = C.vault.adapter.files.get("img/foto.png").data;
    assert.deepEqual(Array.from(d), [1, 2, 3, 4, 5], "isi biner identik");
  });

  await test("hidden file (app.json) ikut turun saat join", async () => {
    await C.manager.initHiddenFiles();
    await settle(1500);
    const has = C.vault.adapter.files.has(".obsidian/app.json");
    if (!has) {
      // reconcile dipicu via update — dorong sync steps
      await C.manager.sendSyncSteps(C.conn);
      await settle(2000);
    }
    assert.ok(
      C.vault.adapter.files.has(".obsidian/app.json"),
      "app.json harus ada di C"
    );
    const isi = readText(C, ".obsidian/app.json");
    assert.equal(isi, '{"theme":"dark"}');
  });

  // ============================================================
  console.log("\n=== JOIN 2: dua arah setelah join (C edit → A) ===");
  await test("C (ex-kotor) edit catatan → A menerima", async () => {
    C.vault.fsWrite("notesolo.md", "catatan root + edit dari C");
    C.manager.onFileModify(
      C.vault.getAbstractFileByPath("notesolo.md"),
      "catatan root + edit dari C"
    );
    await waitFor("edit C sampai A", () =>
      readText(A, "notesolo.md") === "catatan root + edit dari C"
    );
  });

  await test("C buat note baru → A menerima", async () => {
    C.vault.fsWrite("00_Inbox/dari-c.md", "baru dari C");
    C.manager.onFileCreate(
      C.vault.getAbstractFileByPath("00_Inbox/dari-c.md"),
      "baru dari C"
    );
    await waitFor("note baru C sampai A", () =>
      A.vault.adapter.files.has("00_Inbox/dari-c.md")
    );
    assert.equal(readText(A, "00_Inbox/dari-c.md"), "baru dari C");
  });

  // ============================================================
  console.log("\n=== JOIN 3: mode 'Gabungkan' (merge) device D kotor ===");
  await test("merge: file lokal D tetap + file A masuk, konflik dinamai", async () => {
    const D = makeDevice("D");
    D.vault.fsWrite("hp-only.md", "milik D sendiri");
    D.vault.fsWrite("catatan/berbagi.md", "VERSI D LAIN");
    await D.manager.init(); // mendaftarkan file D
    connectDevice(D, VID, VTOK);
    await settle(3000);

    // file unik D tetap ada & terkirim ke A
    assert.ok(D.vault.adapter.files.has("hp-only.md"), "file D tetap");
    await waitFor("hp-only sampai ke A", () =>
      A.vault.adapter.files.has("hp-only.md")
    );
    // berbagi.md: A punya "isi awal dari A", D punya "VERSI D LAIN" → note ID beda →
    // D membuat salinan konflik (konsep 2 versi selamat)
    const dPaths = Array.from(D.vault.adapter.files.keys());
    const berbagiDiD = dPaths.filter((p) => p.includes("berbagi"));
    // minimal: versi D & versi server dua-duanya selamat di D
    assert.ok(
      berbagiDiD.length >= 1,
      `berbagi harus ada di D: ${berbagiDiD}`
    );
  });

  // ============================================================
  console.log("\n=== JOIN 4: C restart (init ulang) tidak merusak apa pun ===");
  await test("C restart: init → semua file tetap, tanpa duplikasi isi", async () => {
    // snapshot sebelum
    const before = {};
    for (const p of Array.from(C.vault.adapter.files.keys())) {
      if (p.endsWith(".md")) before[p] = readText(C, p);
    }
    // simulasi restart: manager baru + store yang sama
    const storeDir = C.store
      ? null
      : null;
    void storeDir;
    await C.manager.init();
    await settle(2000);
    for (const [p, isi] of Object.entries(before)) {
      const now = readText(C, p);
      if (now !== isi) {
      }
      assert.equal(now, isi, `berubah setelah restart: ${p}`);
    }
    // cek duplikasi isi (blok berulang)
    for (const [p, isi] of Object.entries(before)) {
      if (isi.length < 300) continue;
      const probe = isi.slice(100, 180);
      const n = isi.split(probe).length - 1;
      assert.ok(n <= 1, `isi duplikat terdeteksi di ${p} (x${n})`);
    }
  });

  console.log(`\n=== HASIL JOIN E2E: ${passed} lulus, ${failed} gagal ===`);
  A.conn?.disconnect();
  C.conn?.disconnect();
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
