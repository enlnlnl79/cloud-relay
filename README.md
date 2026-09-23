# Cloud Relay

Plugin Obsidian untuk sinkronisasi vault antar device via DB Cloud Relay. Live per kata, offline aman tanpa konflik.

## Dev

```bash
npm install
npm run dev      # watch build -> main.js
npm run build    # production build (tsc + esbuild)
```

## Install ke vault

**Manual (tes):** build dulu (`npm run build`), lalu copy `main.js`, `manifest.json`, `styles.css` ke `<vault>/.obsidian/plugins/cloud-relay/` → enable di Settings → Community Plugins.

**BRAT (auto-update, rekomendasi saat beta):** install plugin BRAT → "Add beta plugin" → masukkan `enlnlnl79/cloud-relay` → BRAT mengambil asset dari GitHub Releases dan auto-update saat ada release baru.

Community Store: menyusul setelah stabil.

Server: https://github.com/… db-cloud-relay
