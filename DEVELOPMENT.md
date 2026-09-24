# Cloud Relay (Plugin Obsidian) — Panduan Lengkap Pengembangan

> Dokumen ini untuk siapa pun yang melanjutkan pengembangan. Berisi
> arsitektur, protokol, invariants yang MENJAGA plugin dari bug korupsi
> yang pernah terjadi, dan workflow rilis.

## 1. Gambaran Besar

Plugin Obsidian yang menyinkronkan vault antar device via server
**DB Cloud Relay** (repo `enlnlnl79/db-cloud-relay`, Rust + yrs + SQLite).
Model: **mirror penuh** — semua file (catatan md, lampiran, pengaturan
`.obsidian`) identik di semua device.

```
Vault Obsidian (file .md, gambar, .obsidian/*.json, themes/)
   │
   ├── NoteSyncManager ── Y.Doc per note (CRDT) ──► WebSocket (frames) ──► server
   │        │                                             ▲
   │        ├── lampiran & file .obsidian ──► blob HTTP (PUT/GET /v1/blobs/{sha})
   │        │
   │        └── SyncStore (blob .bin/.sv + index.json + *-seen.json) di
   │            `.obsidian/plugins/cloud-relay/sync/`
```

**Yang disinkronkan:**
1. **Catatan `.md`** — isi = `Y.Text` per note; path & status hapus = `Y.Map
   "meta"` (note_id UUID stabil → rename aman, tidak dianggap hapus+buat).
2. **Lampiran** (semua non-md) — file di-upload sebagai blob content-addressed
   (SHA-256); metadata path→{sha,size,deleted} di CRDT map `__attachments__`.
3. **Pengaturan** (Hidden File Sync) — `.obsidian/{app,appearance,community-
   plugins,core-plugins,hotkeys,graph}.json` + `themes/**` + `snippets/**`;
   metadata di CRDT map `__hiddens__`. Bisa dimatikan per-device
   (setting `hiddenSync`).

## 2. Struktur Kode

| File | Tugas |
|---|---|
| `src/main.ts` | Plugin class: lifecycle, wiring, API (createVault/testConnection/ resetServerVault/recoverFromServer), event vault, watcher `.obsidian`, boot.log |
| `src/sync/note-sync.ts` | **Jantung** (~1100 baris): NoteSyncManager — CRDT docs, diff prefix-suffix, apply remote (queue serial), attachment & hidden sync, self-write guard, persist |
| `src/sync/connection.ts` | WebSocket: frame encode/decode, reconnect backoff 1s→30s, heartbeat PING 15s + watchdog zombie 35s |
| `src/sync/protocol.ts` | Format frame (sinkron dengan server) |
| `src/sync/persist.ts` | SyncStore: blob per note (`.bin` = state penuh, `.sv` = state vector), index.json, attach-seen/hidden-seen |
| `src/sync/status.ts` | Status bar kaya: `● ↑n ↓n ⚙n` + warnIfBusy |
| `src/ui/settings-tab.ts` | Wizard: pilih peran → (buat: URL → admin token) / (join: link → verifikasi → info → peringatan) ; status: invite, cek, pulihkan, opsi berbahaya (klik 2x) |
| `src/settings.ts` | Tipe settings + parse/build invite link `cloudrelay://join#s=URL&v=VAULT&k=TOKEN` |

## 3. Protokol (HARUS cocok dengan server)

Frame: `[type:1][id_len:2 BE][id][payload]`
`0` DOC_LIST, `1` SYNC_STEP1, `2` SYNC_STEP2, `3` UPDATE, `254` PING, `255` PONG.
Detail alur & HTTP API: lihat `DEVELOPMENT.md` di repo server.

ID khusus (server transparan, plugin yang mengartikan):
- `__attachments__` — Y.Map path→{sha,size,deleted}
- `__hiddens__` — Y.Map path→{sha,size,deleted} (file .obsidian)

## 4. INVARIANTS KRITIS (dibayar dengan insiden nyata)

Baca ini sebelum mengubah note-sync.ts. Tiga bug di bawah pernah
menghancurkan isi vault user (duplikasi blok 168–520×) dan semuanya
melanggar invariant ini:

### I1 — Tulisan sendiri tidak boleh diproses sebagai edit user (self-write guard)
Plugin menulis file (apply remote) → Obsidian memicu event `modify` untuk
tulisan kita sendiri. Kalau diproses → isi disisip ulang → duplikasi
berlipat per putaran.

Mekanisme sekarang (**dua lapis, keduanya wajib**):
1. `applyingRemoteByPath` — synchronous, dilepas setelah `await vault.modify()`
   selesai. CUKUP untuk event yang datang sebelum await selesai, TAPI...
2. `selfWrites` map path→{mtime, until: now+5s} — `markSelfWrite()` dipanggil
   SETELAH setiap tulis (create/modify/rename/delete, note maupun lampiran),
   `isSelfWrite()` mengembalikan true jika event membawa mtime ≤ recorded+5ms
   dan belum kedaluwarsa 5 detik.

**Aturan pengembangan**: setiap `vault.*` write baru HARUS diikuti
`markSelfWrite(path, mtime)` dan setiap handler event HARUS cek
`isSelfWrite` lebih dulu.

### I2 — Doc lokal tidak boleh "mengulang" isi yang sudah ada (blob stale guard)
Saat startup, kalau `lastContent` kosong tapi file berisi DAN `idx.mtime !== 0`
(artinya pernah tersinkron sebelumnya) → blob lokal tertinggal (crash saat
debounce) → **JANGAN diff-insert** (itu duplikasi!). Skip, biarkan sync dari
server yang memperbaiki. Terjadi di `init()` dan `onFileModify`.

### I3 — Semua apply remote lewat queue serial (`queueApply`) + persist setelah tulis
- Apply paralel dulu pernah membuat Obsidian hang (146 operasi file serentak).
- Persist blob kini LANGSUNG (`persistNow`) setelah setiap apply remote +
  flush loop 2s + flush saat unload. Debounce 3s hanya untuk index/attach-seen.

### I4 — mtime adalah kunci perubahan
`index[id].mtime` = mtime file terakhir yang diproses. init hanya memproses
file yang mtimenya beda. Update mtime SETIAP kali file diproses (lokal
maupun remote) — kalau tidak, diff diulang setiap startup.

## 5. Alur Penting

### 5.1 Startup (`onload`)
```
loadSettings → boot.log → init(store: index + sv cache, mtime-diff per file,
  skip blob-stale) → register events → startSync jika enabled
  → setHttpTransport → applyLimits → connect WS → onDocList:
      - kirim SYNC_STEP1 per note (SV dari .sv cache — startup cepat)
      - initHiddenFiles + initAttachments (upload yg belum ada)
```
`boot.log` (di folder plugin) = alat debug pertama saat plugin "tidak
melakukan apa-apa": harus muncul `onload start → init selesai → events
terpasang (→ initHidden selesai)`.

### 5.2 Join wizard (device baru)
```
pilih peran → paste invite link → parse → testConnection (GET /info)
  → halaman info (N catatan, update terakhir) → [vault tidak kosong?]
  → peringatan: "Ikuti device pertama (ganti total)" = wipe SEMUA file
     (trash) + reset store → join ; atau "Gabungkan" = merge biasa
```
Setelah join, device mendapat semua note via SYNC_STEP2 + lampiran +
pengaturan via blob.

### 5.3 Reset server vault vs Pulihkan dari server (bedakan!)
- **Reset server vault** (device sumber pertama): hapus semua catatan di
  SERVER + reset store lokal → device ini mengunggah ulang semua. Device
  lain HARUS join ulang "ganti total".
- **Pulihkan dari server** (device mana pun): lokal saja — trash semua md
  + reset store → tarik ulang dari server. Server tidak disentuh. Obat
  untuk korupsi lokal.

## 6. Penyimpanan Lokal (`.obsidian/plugins/cloud-relay/sync/`)

| File | Isi | Catatan |
|---|---|---|
| `<uuid>.bin` | `Y.encodeStateAsUpdate(doc)` — state penuh | ditulis persistNow |
| `<uuid>.sv` | state vector | supaya startup tak perlu load .bin |
| `index.json` | noteId→{path, deleted, mtime} | sumber kebenaran mapping |
| `attach-seen.json` | path→{sha, mtime} | cache lampiran (hindari re-hash) |
| `hidden-seen.json` | path→{sha, mtime} | cache file .obsidian |
| `__attachments__.bin/.sv`, `__hiddens__.bin/.sv` | doc metadata | |

## 7. Build, Rilis, Distribusi

```bash
npm install
npm run dev      # watch (dev)
npm run build    # tsc + esbuild production → main.js
```

**Rilis (BRAT membaca GitHub Releases, harus prerelease=false!):**
1. Naikkan versi di `manifest.json` + `package.json` + tambah entry
   `versions.json` (`"X.Y.Z": "1.5.0"` = minAppVersion).
2. `npm run build`.
3. Copy `main.js manifest.json styles.css` ke vault dev:
   `/Users/enl/Allenl/Obsidian/obsidian-livesync/.obsidian/plugins/cloud-relay/`
4. Commit + push. Buat **GitHub Release** (tag = versi, `prerelease: false`)
   dan upload 3 file itu sebagai asset. (Sesi ini memakai API `gh` via token
   credential helper — atau `gh release create` kalau CLI tersedia.)

Distribusi: BRAT (beta, auto-update) → nanti Community Store (perlu review,
styles/manifest rapi, README).

**Testing manual minimum sebelum rilis** (tidak ada CI test di repo ini):
1. Restart Obsidian (cek `boot.log` lengkap).
2. `Cek sekarang`: catatan lokal = server, belum terkirim/diterima = 0.
3. Edit note di Mac → muncul di device kedua < 1s (live per kata).
4. Matikan WiFi device kedua → edit → nyalakan → merge tanpa duplikasi.
5. Scan duplikasi cepat: potongan tengah file tidak boleh muncul ≥3×.
6. Tes tombol Pulihkan dari server di device kedua (hasil identik).

## 8. Pitfall yang Pernah Terjadi (jangan ulangi)

| Gejala | Sebab | Solusi |
|---|---|---|
| Plugin "tidak load" padahal terpasang | entry hilang dari `community-plugins.json` — **pkill -9 saat Obsidian shutdown menulis ulang file itu** | matikan plugin via UI atau cek file tsb setelah pkill |
| File `.obsidian` tidak terdeteksi | `vault.getFiles()` TIDAK melacak `.obsidian/` | pakai `vault.adapter.list(".obsidian")` |
| Catatan duplikat berlipat saat restart | blob stale (lihat I2) | guard sudah ada — jangan dihapus |
| 401 saat Create Vault | admin token salah paste | server log `ADMIN_TOKEN=` satu baris |
| BRAT "tidak menemukan plugin" | release ditandai prerelease | set `prerelease: false` |
| Body fetch ditolak TS | `Uint8Array<ArrayBufferLike>` ≠ BodyInit | `data.slice().buffer as ArrayBuffer` |
| Catatan raksasa (100MB, Web Clipper) meracuni sync | tidak ada guard | setting `maxNoteMB` (default 0 = tanpa batas, KEPUTUSAN USER: mirror mutlak) |

## 9. Keputusan Produk (kesepakatan dengan user — jubah tanpa izin)

- **Mirror mutlak**: semua file wajib identik semua device, berapapun
  ukurannya (default `maxNoteMB=0`).
- **Tanpa E2EE** (self-host pribadi; dicatat jujur untuk rilis publik).
- **Istilah**: "sumber pertama" (device pertama join) vs "pengikut";
  semua device adalah sumber setelahnya.
- Tanpa akun; invite link = capability; revoke = rotate token server-side
  (belum ada UI — lihat roadmap).
- Bahasa UI: Indonesia.

## 10. Roadmap

1. UI rotate/revoke token (endpoint server belum ada).
2. Selective sync per folder (setting `syncFilters`).
3. E2EE opsional per vault (payload Yjs dienkripsi, server tetap bego).
4. Awareness (kursor collaborator realtime) — y-protocols awareness.
5. Unit test (vitest) utk note-sync: diffText, guard, dedup detector.
6. Community Store submission setelah stabil.
