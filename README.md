# testbench

## VR Expert Diagnostics: headset health check over WebUSB (proof of concept)

A static web page (`docs/`) that connects to a Pico headset over ADB using WebUSB and lets you explore every system property (`getprop`) in detail, plus battery, storage, memory, thermal and sensor output. Read-only: it never changes anything on the headset.

- **Overview** (default tab): health verdict (Healthy, Needs attention, Not healthy) from battery, thermal, storage, software and sensor checks, with thresholds in `LIMITS` in `src/main.js`.
- **Properties**: searchable list of all `getprop` entries, grouped by category (Pico / XR, Build, Product, Security, Display, Hardware, Network, Services...), with a detail panel (meaning, type, interpreted value, related properties) and JSON / CSV export.
- **Raw output**: the unprocessed output of every command that was run.
- **Load sample data** shows the interface with fictional data, no headset needed.

### Requirements

- Chrome or Edge, served over HTTPS (or `localhost`).
- USB debugging enabled on the headset.
- Windows: the WinUSB driver for the ADB interface (for example via Zadig), and no other ADB server running (`adb kill-server`, close SideQuest / Android Studio).

### Build

```
npm install
npx esbuild src/main.js --bundle --minify --format=iife --target=chrome110 --outfile=docs/main.js
```

`docs/index.html` and `docs/main.js` are what GitHub Pages serves.
