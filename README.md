# testbench

## Headset Diagnostics: health check over WebUSB (proof of concept)

A static web page (`docs/`) that connects to a Pico headset over ADB using WebUSB, runs a health check and keeps every result as a case with notes. Read-only: it never changes anything on the headset.

- **Overview** (default tab): health verdict (Healthy, Needs attention, Not healthy) from battery, thermal, storage, software and sensor checks, with thresholds in `LIMITS` in `src/main.js`. Also the device tests and the case notes.
- **Device tests**: installs a small test app (`android/`) on the headset and measures orientation drift, proximity sensor, speakers and microphone, storage and CPU under load.
- **Cases**: every diagnosis is saved automatically. Search by serial, model, technician or notes; reopen any case.
- **Properties**: searchable list of all `getprop` entries with a detail panel and JSON / CSV export.
- **Raw output**: the unprocessed output of every command that was run.
- **Open report** loads an exported JSON; **Try with sample data** shows the interface with fictional data.

### Requirements

- Chrome or Edge, served over HTTPS (or `localhost`).
- USB debugging enabled on the headset.
- Windows: the WinUSB driver for the ADB interface (for example via Zadig), and no other ADB server running (`adb kill-server`, close SideQuest / Android Studio).

### Cases and notes

After a diagnosis, the **Case notes** panel records what actually turned out to be wrong:

- how the diagnosis compared with reality (matched, missed the problem, false alarm, unsure),
- symptoms observed, free-text notes and the repair or resolution,
- the technician.

For example: "all checks passed, but the headset still loses tracking". These notes are what make it possible to improve the checks later.

By default cases are stored in the browser on that computer. To share them with the whole team, set up shared storage:

1. Create a free project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run `supabase/schema.sql`.
3. In **Authentication → Providers → Email**, turn off "Allow new users to sign up", then add each team member under **Authentication → Users → Add user**.
4. In **Project Settings → API**, copy the Project URL and the `anon` public key into `docs/config.js`.
5. Commit and push. A **Sign in** button appears in the header.

Signed-in technicians read and write the same list of cases. Cases saved before signing in are uploaded when they sign in. Row-level security means only signed-in users can read or write; nothing can be deleted from the page. Properties that can identify a customer's network (DHCP, DNS, MAC, SSID and similar) are removed before a case is saved.

### Test app

`android/` is the test app. GitHub Actions builds it on every change and publishes `docs/bench.apk` next to the page, which installs it from there.

### Build the page

```
npm install
npx esbuild src/main.js --bundle --minify --format=iife --target=chrome110 --outfile=docs/main.js
```

`docs/index.html`, `docs/config.js` and `docs/main.js` are what GitHub Pages serves.
