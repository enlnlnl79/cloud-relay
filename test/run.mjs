// Test harness — reproduksi bug audit sebelum fix.
// Jalankan: node test/run.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const M = require("./entry.bundle.cjs");
const assert = require("assert");
const Y = require("yjs");

const {
  NoteSyncManager,
  encodeFrame,
  decodeFrame,
  parseDocList,
  parseInviteLink,
  buildInviteLink,
  diffText,
  TFile,
  MockVault,
} = M;

// global env yang dibutuhkan note-sync
globalThis.window = globalThis;

// ---- mock fetch untuk blob API (PUT/GET /v1/blobs/{sha}) ----
const blobStore = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/\/v1\/blobs\/([0-9a-f]{64})/);
  if (!m) return realFetch(url, init);
  const sha = m[1];
  if (init?.method === "PUT") {
    blobStore.set(sha, init.body);
    return { ok: true, status: 201 };
  }
  if (blobStore.has(sha)) {
    const data = blobStore.get(sha);
    const buf = data instanceof Uint8Array ? data.buffer : data;
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  }
  return { ok: false, status: 404 };
};

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      failures.push({ name, error: e });
      console.log(`  ✗ ${name}`);
      console.log(`      ${e.message.split("\n")[0]}`);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  // beri waktu semua promise chain + debounce berjalan
  for (let i = 0; i < 12; i++) await sleep(10);
}

function makeManager(vault, storeDir) {
  return makeManagerShared(vault, {});
}

function makeManagerShared(vault, seedJsons) {
  // SyncStore mock (folder berbasis Map di memori)
  const blobs = new Map();
  const jsons = new Map(Object.entries(seedJsons || {}));
  const store = {
    async ensureDir() {},
    async readBlob(id) {
      return blobs.get(id) ?? null;
    },
    async writeBlob(id, data, sv) {
      blobs.set(id, data);
    },
    async readSv(id) {
      const d = blobs.get(id);
      if (!d) return null;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, d);
      return new Uint8Array(Y.encodeStateVector(doc));
    },
    async readIndex() {
      return jsons.get("index") ?? {};
    },
    async writeIndex(idx) {
      jsons.set("index", idx);
    },
    async readAttachSeen() {
      return jsons.get("attach") ?? {};
    },
    async writeAttachSeen(s) {
      jsons.set("attach", s);
    },
    async readHiddenSeen() {
      return jsons.get("hidden") ?? {};
    },
    async writeHiddenSeen(s) {
      jsons.set("hidden", s);
    },
    async archive() {},
  };
  const app = { vault, fileManager: {} };
  const manager = new NoteSyncManager(app, vault, store);
  return { manager, store, blobs, jsons };
}

// Conn mock: kumpulkan frame terkirim
function makeConn() {
  const sent = [];
  return { sent, send: (f) => sent.push(f) };
}

(async () => {
  console.log("\n=== UNIT: protocol ===");
  await test("frame round-trip (tipe, id, payload)", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const f = encodeFrame(3, "note-id-😀", payload);
    const d = decodeFrame(f);
    assert.equal(d.type, 3);
    assert.equal(d.noteId, "note-id-😀");
    assert.deepEqual(Array.from(d.payload), Array.from(payload));
  });
  await test("frame id panjang >255 ditolak/di-handle", () => {
    const longId = "x".repeat(300);
    const f = encodeFrame(1, longId, new Uint8Array(0));
    const d = decodeFrame(f);
    // kalau encode salah, decode menghasilkan id salah → tangkap di sini
    assert.equal(d && d.noteId === longId, true, `id harus utuh, dapat: ${d?.noteId?.length}`);
  });
  await test("parseDocList multi-id", () => {
    const ids = ["a", "bb", "ccc"];
    const parts = [];
    for (const id of ids) {
      const b = new TextEncoder().encode(id);
      const len = new Uint8Array([(b.length >> 8) & 0xff, b.length & 0xff]);
      parts.push(len, b);
    }
    const payload = new Uint8Array(parts.flatMap((x) => Array.from(x)));
    const parsed = parseDocList(payload);
    assert.deepEqual(parsed, ids);
  });

  console.log("\n=== UNIT: diffText ===");
  await test("insert di tengah", () => {
    const d = diffText("hello world", "hello brave world");
    assert.equal(d.retain, 6);
    assert.equal(d.ins, "brave ");
    assert.equal(d.del, 0);
  });
  await test("delete di akhir", () => {
    const d = diffText("hello world", "hello");
    assert.equal(d.retain, 5);
    assert.equal(d.del, 6); // " world" = 6 karakter
    assert.equal(d.ins, "");
  });
  await test("replace tengah", () => {
    const d = diffText("kopi susu", "kopi hitam");
    assert.equal(d.del, 4);
    assert.equal(d.ins, "hitam");
  });
  await test("identik", () => {
    const d = diffText("sama", "sama");
    assert.equal(d.del, 0);
    assert.equal(d.ins, "");
  });
  await test("unicode aman (emoji)", () => {
    const d = diffText("a😀b", "a🎉b");
    assert.ok(d.ins.includes("🎉") || d.del > 0);
  });

  console.log("\n=== UNIT: invite link ===");
  await test("parse/build round-trip", () => {
    const link = buildInviteLink({
      serverUrl: "https://relay.example.com",
      vaultId: "abc123",
      vaultToken: "tok-xyz",
      adminToken: "",
      isPrimary: false,
      enabled: true,
      maxNoteMB: 0,
      hiddenSync: true,
    });
    const parsed = parseInviteLink(link);
    assert.ok(parsed);
    assert.equal(parsed.serverUrl, "https://relay.example.com");
    assert.equal(parsed.vaultId, "abc123");
    assert.equal(parsed.vaultToken, "tok-xyz");
  });
  await test("link rusak → null", () => {
    assert.equal(parseInviteLink("https://bukan-link"), null);
    assert.equal(parseInviteLink("cloudrelay://join#s=saja"), null);
  });

  console.log("\n=== INTEGRATION: race modify (BUG B) ===");
  await test("dua modify beruntun TIDAK boleh menduplikasi isi", async () => {
    const vault = new MockVault();
    vault.fsWrite("n1.md", "hello");
    const { manager } = makeManager(vault);
    await manager.init();
    const conn = makeConn();
    manager.setConn(conn);

    const f1 = vault.getAbstractFileByPath("n1.md");
    // dua perubahan beruntun SEBELUM async pertama selesai (simulasi save ganda)
    vault.fsWrite("n1.md", "hello world");
    const f2 = vault.getAbstractFileByPath("n1.md");
    manager.onFileModify(f2, "hello world");
    vault.fsWrite("n1.md", "hello world!");
    const f3 = vault.getAbstractFileByPath("n1.md");
    manager.onFileModify(f3, "hello world!");
    await settle();

    const diag = manager.diagnostic();
    const id = diag.localNoteIds[0];
    // ambil isi doc via blobs
    const blob = (await makeManager(vault).manager) ? null : null;
    // baca via conn frames tidak praktis; gunakan akses internal lewat apply balik:
    // cukup cek isi file + jumlah frame update unik
    assert.equal(
      vault.adapter.files.get("n1.md") &&
        new TextDecoder().decode(vault.adapter.files.get("n1.md").data),
      "hello world!"
    );
    // hitung panjang total update terkirim — duplikasi akan bikin update besar ganda
    const texts = conn.sent.map((f) => {
      const d = decodeFrame(f);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, d.payload);
      } catch {}
      return doc.getText("content").toString();
    });
    const joined = texts.join("|");
    const occurrences = joined.split("hello world").length - 1;
    assert.ok(
      occurrences <= 2,
      `'hello world' muncul ${occurrences}x di update terkirim — indikasi duplikasi CRDT: [${texts.join(" | ")}]`
    );
  });

  console.log("\n=== INTEGRATION: hidden file delete-cascade (BUG A) ===");
  await test("initHiddenFiles TIDAK menandai deleted utk file lokal yang ada", async () => {
    const vault = new MockVault();
    // file .obsidian lokal ADA (di adapter/fs)
    vault.adapter.files.set(".obsidian/app.json", {
      data: new TextEncoder().encode("{}"),
      mtime: Date.now(),
    });
    vault.adapter.folders.add(".obsidian");

    const { manager } = makeManager(vault);
    manager.setHttpTransport({ baseUrl: "http://unused", token: "t" });
    manager.setHiddenSyncEnabled(true);

    // map remote berisi app.json dari device lain (non-deleted)
    // → simulasikan dengan menjalankan initHiddenFiles sekali (mengisi map), lalu
    //    jalankan LAGI seolah device lain (fresh manager dengan index yang sama)
    await manager.initHiddenFiles();
    await settle();
    // jalankan kedua kalinya (seperti device lain yang punya entri map dari server)
    await manager.initHiddenFiles();
    await settle();

    const hd = await manager.hiddenDiagnostic();
    assert.equal(
      hd.meta,
      1,
      `meta harus 1 (file ada lokal), dapat ${hd.meta} — kalau 0, file ditandai deleted padahal ada (BUG A)`
    );
  });

  console.log("\n=== INTEGRATION: attachment startup (BUG C) ===");
  await test("attachment di fs tapi belum ter-index TIDAK dianggap terhapus", async () => {
    const vault = new MockVault();
    const { manager, jsons } = makeManager(vault);
    manager.setHttpTransport({ baseUrl: "http://unused", token: "t" });

    // ronde 1: file ter-index normal, attachSeen terisi (persist ke store)
    vault.fsWriteBinary("img/pic.png", new Uint8Array([1, 2, 3]));
    await manager.init();
    await manager.initAttachments();
    await settle();
    const seenAfterRound1 = jsons.get("attach");
    assert.ok(seenAfterRound1 && seenAfterRound1["img/pic.png"], "attachSeen terisi ronde 1");

    // ronde 2: Obsidian RESTART — index belum memuat file (fs masih ada),
    // tapi attachSeen dari disk masih berisi file itu
    vault.indexed.clear();
    // manager baru memakai store yang sama (attachSeen sama)
    const { manager: m2 } = makeManagerShared(vault, { attach: seenAfterRound1 });
    m2.setHttpTransport({ baseUrl: "http://unused", token: "t" });
    await m2.init();
    await settle();

    // inti: map attachment TIDAK boleh berisi pic.png sebagai deleted
    const ad = m2.attachmentDiagnostic();
    assert.equal(
      ad.meta,
      0,
      `meta harus 0 (belum ada di map, tidak ditandai deleted); dapat ${ad.meta}`
    );
    assert.ok(vault.adapter.files.has("img/pic.png"), "file masih ada di fs");
  });

  console.log("\n=== INTEGRATION: self-write guard ===");
  await test("applyRemote create → event modify self ditolak (tanpa duplikasi)", async () => {
    const vault = new MockVault();
    const { manager } = makeManager(vault);
    await manager.init();
    const conn = makeConn();
    manager.setConn(conn);

    // buat update "isi baru" dari device lain
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "isi dari server");
    remote.getMap("meta").set("path", "remote.md");
    remote.getMap("meta").set("deleted", false);
    const update = Y.encodeStateAsUpdate(remote);

    await manager.onUpdate("remote-id", new Uint8Array(update));
    await settle();

    // event modify untuk tulisan sendiri: mtime dari file hasil create
    const f = vault.getAbstractFileByPath("remote.md");
    assert.ok(f, "file harus terbuat");
    const contentBefore = new TextDecoder().decode(
      vault.adapter.files.get("remote.md").data
    );
    assert.equal(contentBefore, "isi dari server");

    // simulasikan event modify yang datang (masih dalam jendela 5 detik)
    manager.onFileModify(f, "isi dari server");
    await settle();
    const contentAfter = new TextDecoder().decode(
      vault.adapter.files.get("remote.md").data
    );
    assert.equal(contentAfter, "isi dari server");

    // dan CRDT tidak dobel: update berikutnya dari lokal harus menghasilkan teks tunggal
    vault.fsWrite("remote.md", "isi dari server + edit lokal");
    const f2 = vault.getAbstractFileByPath("remote.md");
    manager.onFileModify(f2, "isi dari server + edit lokal");
    await settle();
    const contentFinal = new TextDecoder().decode(
      vault.adapter.files.get("remote.md").data
    );
    assert.equal(contentFinal, "isi dari server + edit lokal");
  });

  console.log("\n=== INTEGRATION: rename konflik (BUG E) ===");
  await test("applyRemote rename ke path yang sudah ada TIDAK crash & tidak hilang", async () => {
    const vault = new MockVault();
    vault.fsWrite("lama.md", "isi lama");
    vault.fsWrite("baru.md", "isi milik user"); // target sudah ditempati
    const { manager } = makeManager(vault);
    await manager.init();
    manager.setConn(makeConn());

    // remote rename lama.md → baru.md
    const remote = new Y.Doc();
    remote.getText("content").insert(0, "isi lama");
    remote.getMap("meta").set("path", "baru.md");
    remote.getMap("meta").set("deleted", false);
    const update = Y.encodeStateAsUpdate(remote);

    await manager.onUpdate("conflict-id", new Uint8Array(update));
    await settle();

    // tidak throw + isi user tidak tertimpa
    const baru = new TextDecoder().decode(vault.adapter.files.get("baru.md").data);
    assert.equal(
      baru,
      "isi milik user",
      "file milik user tidak boleh tertimpa rename remote"
    );
  });

  console.log("\n=== INTEGRATION: delete remote (ID beda antar device — BUG P) ===");
  await test("applyRemote delete → file terhapus, event delete self ditolak", async () => {
    const vault = new MockVault();
    vault.fsWrite("hapus.md", "isi");
    const { manager } = makeManager(vault);
    await manager.init();
    const conn = makeConn();
    manager.setConn(conn);

    const remote = new Y.Doc();
    remote.getText("content").insert(0, "isi");
    remote.getMap("meta").set("path", "hapus.md");
    remote.getMap("meta").set("deleted", true);
    const update = Y.encodeStateAsUpdate(remote);
    await manager.onUpdate("del-id", new Uint8Array(update));
    await settle();

    assert.ok(!vault.adapter.files.has("hapus.md"), "file harus terhapus");
    const diag = manager.diagnostic();
    assert.equal(diag.localNoteIds.length, 0, "tidak tersisa di index aktif");
  });

  console.log(`\n=== HASIL: ${passed} lulus, ${failed} gagal ===`);
  if (failed > 0) {
    console.log("\nDetail kegagalan:");
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
