import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { SAMPLE_PROPS, SAMPLE_RAW } from "./sample.js";

const $ = (id) => document.getElementById(id);

// Read-only commands run on connect. `getprop` feeds the Properties tab.
const RAW_COMMANDS = [
  ["Battery", "dumpsys battery"],
  ["Battery sysfs", "for f in cycle_count charge_full charge_full_design capacity; do echo $f=$(cat /sys/class/power_supply/battery/$f 2>/dev/null); done"],
  ["Thermal", "dumpsys thermalservice"],
  ["Storage", "df -h /data"],
  ["Memory", "cat /proc/meminfo"],
  ["Sensors", "dumpsys sensorservice"],
  ["Pico packages", "pm list packages | grep -i pico"],
];

const state = {
  adb: null,
  serial: "",
  props: [],
  raw: {},
  sample: false,
  cat: "all",
  kind: "all",
  q: "",
  selected: null,
};

/* ---------- classification ---------- */

const CATEGORIES = [
  ["Pico / XR", /pico|pxr|picovr|(^|[._])xr([._]|$)|slam|tracking|controller|6dof|(^|[._])vr([._]|$)/i],
  ["Build", /^ro\.([a-z_]+\.)?build\.|^ro\.build/],
  ["Product", /^ro\.([a-z_]+\.)?product\./],
  ["Security", /selinux|verity|vbmeta|crypto|keystore|^ro\.(secure|debuggable|adb)|avb|oem_unlock|^persist\.sys\.usb/],
  ["Display & GPU", /display|lcd|density|screen|refresh|^ro\.(sf|surface|opengles|hwui)|vulkan|^persist\.sys\.sf|gpu/],
  ["Camera & sensors", /camera|sensor/],
  ["Audio", /audio|^media\.|^ro\.config\.(alarm|ringtone|notification)/],
  ["Hardware", /^ro\.(hardware|board|soc|arch|chipname|cpu)|^ro\.boot\.hardware|(^|\.)cpu|abi/],
  ["Boot", /^ro\.boot|^ro\.bootmode|^ro\.bootloader|^sys\.boot|^ro\.bootimage/],
  ["Network", /^(net|dhcp|wifi|wlan|gsm|ril|bt)\.|bluetooth|wifi|^ro\.telephony|radio|^ro\.carrier/],
  ["ART / Dalvik", /dalvik|dexopt|^ro\.art|(^|\.)art\./],
  ["Services", /^init\.svc\./],
  ["Runtime & debug", /^(sys|vold|service|debug|dev|ctl|init|ro\.runtime)\./],
  ["Persistent", /^persist\./],
];

function categorize(key) {
  for (const [name, re] of CATEGORIES) if (re.test(key)) return name;
  return "Other";
}

function kindOf(key) {
  if (key.startsWith("ro.")) return "ro";
  if (key.startsWith("persist.")) return "persist";
  return "runtime";
}

const PREFIX_INFO = [
  ["ro.", "Read-only. Fixed at build or boot time; cannot change while the system runs."],
  ["persist.", "Persistent. Saved to disk and kept across reboots."],
  ["init.svc.", "State of an init service (running, stopped, restarting)."],
  ["sys.", "Runtime state published by the system."],
  ["vendor.", "Vendor-defined property, usually read by a HAL or driver."],
  ["debug.", "Debug or tuning flag. Normally resets on reboot."],
  ["dev.", "Device runtime state."],
  ["net.", "Network runtime state."],
  ["dhcp.", "DHCP lease information."],
  ["gsm.", "Telephony / modem state."],
  ["service.", "Service-specific runtime property."],
  ["vold.", "Volume daemon (storage) state."],
];

const KNOWN = {
  "ro.product.model": "Marketing model name reported by the firmware.",
  "ro.product.manufacturer": "Device manufacturer.",
  "ro.product.device": "Internal device codename.",
  "ro.product.name": "Internal product name.",
  "ro.product.brand": "Brand string.",
  "ro.serialno": "Serial number as seen by ADB.",
  "ro.boot.serialno": "Serial number passed by the bootloader.",
  "ro.build.fingerprint": "Unique build identifier: brand/product/device:version/id/incremental:type/tags.",
  "ro.build.display.id": "Human-readable firmware build string.",
  "ro.build.version.release": "Android version.",
  "ro.build.version.sdk": "Android API level.",
  "ro.build.version.security_patch": "Date of the Android security patch level.",
  "ro.build.version.incremental": "Incremental build number; changes with every firmware build.",
  "ro.build.type": "Build type: user, userdebug or eng.",
  "ro.build.tags": "Signing tags: release-keys or test-keys.",
  "ro.build.date.utc": "Build time as a Unix timestamp (seconds, UTC).",
  "ro.build.date": "Build time as text.",
  "ro.build.characteristics": "Device class flags (for example default, tablet).",
  "ro.hardware": "Hardware platform name (kernel / init selects hardware-specific scripts from this).",
  "ro.board.platform": "SoC platform codename.",
  "ro.product.cpu.abi": "Primary CPU instruction set.",
  "ro.product.cpu.abilist": "All supported CPU instruction sets, in preference order.",
  "ro.bootloader": "Bootloader version.",
  "ro.bootmode": "How the device was booted (normal, recovery, ...).",
  "ro.debuggable": "1 if the build allows debugging of any app. Should be 0 on retail firmware.",
  "ro.secure": "1 if the system enforces security (adbd drops root).",
  "ro.adb.secure": "1 if ADB requires RSA key authorization.",
  "ro.boot.verifiedbootstate": "Verified boot result: green, yellow, orange or red.",
  "ro.boot.flash.locked": "1 if the bootloader is locked.",
  "ro.boot.veritymode": "dm-verity mode (enforcing, eio, disabled).",
  "ro.sf.lcd_density": "Display density in dpi.",
  "ro.opengles.version": "Supported OpenGL ES version, encoded (196610 = 3.2).",
  "sys.boot_completed": "1 once the system has finished booting.",
  "sys.usb.state": "Active USB functions (for example mtp,adb).",
  "persist.sys.timezone": "Configured time zone.",
  "persist.sys.language": "Configured system language.",
  "persist.sys.locale": "Configured system locale.",
  "gsm.version.baseband": "Modem firmware version.",
  "dalvik.vm.heapsize": "Maximum app heap size.",
  "init.svc.adbd": "State of the ADB daemon.",
  "net.hostname": "Hostname announced on the network.",
};

function describe(key) {
  if (KNOWN[key]) return KNOWN[key];
  if (key.startsWith("init.svc.")) return `Init service “${key.slice(9)}”.`;
  return "";
}

function prefixInfo(key) {
  for (const [p, t] of PREFIX_INFO) if (key.startsWith(p)) return t;
  return "";
}

function typeOf(key, value) {
  if (value === "") return "empty";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase();
  if (key.startsWith("init.svc.") && /^(running|stopped|restarting)$/.test(value)) return value;
  if (/^-?\d+$/.test(value)) return "number";
  if (/^0x[0-9a-f]+$/i.test(value)) return "hex";
  if (/^\d+(\.\d+){1,}$/.test(value)) return "version";
  if (/^\//.test(value)) return "path";
  if (/^https?:\/\//.test(value)) return "url";
  if (value.includes(",")) return "list";
  return "text";
}

function interpret(key, value) {
  if (/date\.utc$|^ro\.build\.date\.utc$/.test(key) && /^\d{9,11}$/.test(value)) {
    return new Date(Number(value) * 1000).toUTCString();
  }
  if (key === "ro.opengles.version" && /^\d+$/.test(value)) {
    const n = Number(value);
    return `OpenGL ES ${n >> 16}.${n & 0xffff}`;
  }
  if (typeOf(key, value) === "list") return value.split(",").map((s) => s.trim()).join("\n");
  return "";
}

/* ---------- parsing ---------- */

function parseGetprop(text) {
  const out = [];
  let key = null;
  let buf = "";
  for (const line of text.split(/\r?\n/)) {
    if (key === null) {
      const m = line.match(/^\[([^\]]+)\]: \[(.*)$/);
      if (!m) continue;
      key = m[1];
      buf = m[2];
    } else {
      buf += "\n" + line;
    }
    if (buf.endsWith("]")) {
      out.push(makeProp(key, buf.slice(0, -1)));
      key = null;
      buf = "";
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function makeProp(key, value) {
  return { key, value, cat: categorize(key), kind: kindOf(key), type: typeOf(key, value) };
}

const prop = (k) => state.props.find((p) => p.key === k)?.value ?? "";

/* ---------- small DOM helpers ---------- */

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids.flat().filter((x) => x != null));
  return n;
}

function highlight(text, q) {
  if (!q) return [document.createTextNode(text)];
  const out = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j < 0) break;
    if (j > i) out.push(document.createTextNode(text.slice(i, j)));
    out.push(el("mark", { text: text.slice(j, j + needle.length) }));
    i = j + needle.length;
  }
  out.push(document.createTextNode(text.slice(i)));
  return out;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = old), 1000);
  } catch {
    setStatus("Clipboard blocked by the browser. Select the text and copy it manually.", "err");
  }
}

// Progress bar while working; the notice bar only appears for errors.
function setStatus(msg, kind = "") {
  $("notice").hidden = kind !== "err";
  if (kind === "err") $("notice").textContent = msg;
  $("progress").className = kind === "busy" ? "busy" : "";
}

/* ---------- rendering: properties ---------- */

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.props.filter((p) => {
    if (state.cat !== "all" && p.cat !== state.cat) return false;
    if (state.kind !== "all" && p.kind !== state.kind) return false;
    if (q && !p.key.toLowerCase().includes(q) && !p.value.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderCats() {
  const counts = new Map();
  for (const p of state.props) counts.set(p.cat, (counts.get(p.cat) || 0) + 1);
  const side = $("cats");
  side.replaceChildren();
  const add = (name, label, n) =>
    side.append(
      el("button", {
        class: "cat",
        "aria-pressed": String(state.cat === name),
        onclick: () => { state.cat = name; renderCats(); renderRows(); },
      }, el("span", { text: label }), el("i", { text: String(n) })),
    );
  add("all", "All properties", state.props.length);
  for (const [name] of [...CATEGORIES, ["Other"]]) if (counts.get(name)) add(name, name, counts.get(name));
}

function keyNode(key, q) {
  const parts = key.split(".");
  const last = parts.pop();
  const wrap = el("span", { class: "k" });
  if (!q) {
    if (parts.length) wrap.append(el("span", { class: "dim", text: parts.join(".") + "." }));
    wrap.append(el("span", { class: "last", text: last }));
  } else {
    wrap.append(...highlight(key, q));
  }
  return wrap;
}

function renderRows() {
  const rows = $("rows");
  const list = filtered();
  const q = state.q.trim();
  if (!state.props.length) {
    rows.replaceChildren(el("div", { class: "msg", text: "Connect a headset to read its system properties." }));
    return;
  }
  if (!list.length) {
    rows.replaceChildren(el("div", { class: "msg", text: "No properties match." }));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of list) {
    const showTag = ["true", "false", "running", "stopped", "restarting", "empty"].includes(p.type);
    frag.append(
      el("div", {
        class: "row", tabindex: "0", role: "button",
        "aria-selected": String(state.selected === p.key),
        "data-key": p.key,
        onclick: () => select(p.key),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(p.key); } },
      },
      keyNode(p.key, q),
      el("div", { class: "v" },
        showTag ? el("span", { class: `tag ${p.type}`, text: p.type }) : null,
        p.type === "empty" ? null : el("span", { class: "txt" }, ...highlight(p.value, q)),
      )),
    );
  }
  rows.replaceChildren(frag);
}

function select(key) {
  state.selected = key;
  for (const r of document.querySelectorAll(".row")) r.setAttribute("aria-selected", String(r.dataset.key === key));
  renderDrawer();
}

function renderDrawer() {
  const d = $("drawer");
  const p = state.props.find((x) => x.key === state.selected);
  if (!p) { d.classList.remove("open"); d.replaceChildren(); return; }
  d.classList.add("open");

  const parts = p.key.split(".");
  const crumbs = el("p", { class: "crumbs" });
  parts.forEach((s, i) => {
    crumbs.append(el("span", { class: i < parts.length - 1 ? "c" : "", text: s }));
    if (i < parts.length - 1) crumbs.append(el("span", { class: "c", text: "." }));
  });

  const interp = interpret(p.key, p.value);
  const meaning = describe(p.key);
  const pre = prefixInfo(p.key);
  const sibs = state.props.filter((x) => x.key !== p.key && x.key.split(".").slice(0, -1).join(".") === parts.slice(0, -1).join(".")).slice(0, 14);

  const dl = el("dl");
  const row = (t, v) => v && dl.append(el("dt", { text: t }), el("dd", {}, v));
  row("Meaning", meaning);
  row("Category", p.cat);
  row("Type", p.type);
  row("Scope", pre);

  const refresh = el("button", {
    class: "btn", text: "Re-read live", disabled: state.adb ? null : "",
    onclick: async (e) => {
      try {
        const v = (await sh(`getprop ${p.key}`)).replace(/\n$/, "");
        const i = state.props.findIndex((x) => x.key === p.key);
        state.props[i] = makeProp(p.key, v);
        renderRows(); renderDrawer();
      } catch (err) { setStatus("Read failed: " + err, "err"); }
    },
  });
  if (!state.adb) refresh.setAttribute("disabled", "");
  else refresh.removeAttribute("disabled");

  const actions = el("div", { class: "actions" },
    el("button", { class: "btn", text: "Copy key", onclick: (e) => copy(p.key, e.target) }),
    el("button", { class: "btn", text: "Copy value", onclick: (e) => copy(p.value, e.target) }),
    el("button", { class: "btn", text: "Copy adb command", onclick: (e) => copy(`adb shell getprop ${p.key}`, e.target) }),
    refresh,
  );

  d.replaceChildren(...[
    el("div", { class: "top" }, crumbs, el("button", { class: "x", "aria-label": "Close", text: "×", onclick: () => select(null) })),
    el("h3", { text: "Value" }),
    el("div", { class: "valbox", text: p.value === "" ? "(empty string)" : p.value }),
    interp ? el("div", {}, el("h3", { text: "Interpreted" }), el("div", { class: "valbox", text: interp })) : null,
    actions, dl,
    sibs.length ? el("div", { class: "related" }, el("h3", { text: "Related properties" }),
      ...sibs.map((s) => el("button", { text: `${s.key.split(".").pop()} = ${s.value || "(empty)"}`, onclick: () => select(s.key) }))) : null,
  ].filter(Boolean));
}

/* ---------- rendering: device header, overview, raw ---------- */

function renderDevice() {
  const w = $("who");
  w.replaceChildren();
  if (!state.props.length) return;
  const bits = [prop("ro.product.model"), prop("ro.serialno") || state.serial, prop("ro.build.display.id")].filter(Boolean);
  bits.forEach((b, i) => { if (i) w.append(" · "); w.append(i === 0 ? el("b", { text: b }) : b); });
  if (state.sample) w.append(el("span", { class: "tag", style: "margin-left:8px;background:var(--warn-bg);color:var(--warn)", text: "Sample data" }));
}

/* ---------- health checks ---------- */

// Thresholds are starting points. Tune them with data from real headsets.
const LIMITS = {
  batteryTemp: [45, 55],      // °C  [warn, fail]
  batteryCycles: [500, 800],
  batteryCapacityMin: [80, 70], // % of design capacity, below = warn / fail
  storageUsed: [90, 97],      // % of /data
  memoryFreeMin: 10,          // % MemAvailable (warn only)
  thermal: { 0: [75, 90], 1: [75, 90], 2: [45, 55], 3: [42, 48], 4: [75, 90] }, // by Android temperature type
  thermalDefault: [75, 90],
};
const THERMAL_TYPE = { 0: "CPU", 1: "GPU", 2: "Battery", 3: "Skin", 4: "USB port" };
const BATTERY_HEALTH = { 1: "Unknown", 2: "Good", 3: "Overheat", 4: "Dead", 5: "Over voltage", 6: "Failure", 7: "Cold" };
const THERMAL_STATUS = ["None", "Light", "Moderate", "Severe", "Critical", "Emergency", "Shutdown"];

const num = (x) => (x == null || x === "" || Number.isNaN(Number(x)) ? null : Number(x));
const grab = (t, re) => t.match(re)?.[1] ?? null;
const level = (v, [warn, fail]) => (v >= fail ? "fail" : v >= warn ? "warn" : "ok");

function computeChecks() {
  const checks = [];
  const add = (group, name, status, value, detail) => checks.push({ group, name, status, value: value ?? "", detail: detail ?? "" });
  const missing = (group, name, why = "No data returned by the headset.") => add(group, name, "na", "", why);

  /* Power */
  const bat = state.raw["Battery"] || "";
  if (!bat.includes("level")) {
    missing("Power", "Battery health"); missing("Power", "Battery temperature");
  } else {
    const present = grab(bat, /present:\s*(\w+)/);
    const h = num(grab(bat, /health:\s*(\d+)/));
    if (present === "false") add("Power", "Battery health", "fail", "Not detected", "The system reports no battery present.");
    else if (h == null || h === 1) missing("Power", "Battery health", "Android reports health as unknown.");
    else add("Power", "Battery health", h === 2 ? "ok" : h === 7 ? "warn" : "fail", BATTERY_HEALTH[h] || String(h),
      h === 2 ? "Reported by the battery service." : "Reported by the battery service. Inspect the battery and charging circuit.");
    const t = num(grab(bat, /temperature:\s*(-?\d+)/));
    if (t == null) missing("Power", "Battery temperature");
    else add("Power", "Battery temperature", level(t / 10, LIMITS.batteryTemp), (t / 10).toFixed(1) + " °C", `Warning from ${LIMITS.batteryTemp[0]} °C, failure from ${LIMITS.batteryTemp[1]} °C.`);
  }
  const sys = Object.fromEntries((state.raw["Battery sysfs"] || "").split("\n").map((l) => l.split("=")).filter((a) => a.length === 2));
  const cycles = num(sys.cycle_count);
  if (cycles == null) missing("Power", "Charge cycles", "Not exposed by this firmware.");
  else add("Power", "Charge cycles", level(cycles, LIMITS.batteryCycles), String(cycles), `Warning from ${LIMITS.batteryCycles[0]}, failure from ${LIMITS.batteryCycles[1]}.`);
  const full = num(sys.charge_full), design = num(sys.charge_full_design);
  if (!full || !design) missing("Power", "Battery capacity", "Design capacity not exposed by this firmware.");
  else {
    const pct = Math.round((full / design) * 100);
    add("Power", "Battery capacity", pct < LIMITS.batteryCapacityMin[1] ? "fail" : pct < LIMITS.batteryCapacityMin[0] ? "warn" : "ok",
      pct + "% of design", `Warning below ${LIMITS.batteryCapacityMin[0]}%, failure below ${LIMITS.batteryCapacityMin[1]}%.`);
  }

  /* Thermal */
  const th = state.raw["Thermal"] || "";
  const ts = num(grab(th, /Thermal Status:\s*(\d+)/));
  if (ts == null) missing("Thermal", "Throttling state");
  else add("Thermal", "Throttling state", ts >= 3 ? "fail" : ts >= 1 ? "warn" : "ok", THERMAL_STATUS[ts] || String(ts), "Android thermal status; anything above None means the system is limiting performance.");
  const temps = [...th.matchAll(/mValue=(-?[\d.]+), mType=(\d+), mName=([^,}]+)/g)].map((m) => ({ v: Number(m[1]), type: Number(m[2]), name: m[3] }));
  if (!temps.length) missing("Thermal", "Hottest sensor");
  else {
    const worst = temps.map((t) => ({ ...t, lim: LIMITS.thermal[t.type] || LIMITS.thermalDefault })).sort((a, b) => (b.v - b.lim[0]) - (a.v - a.lim[0]))[0];
    add("Thermal", "Hottest sensor", level(worst.v, worst.lim), `${worst.name} ${worst.v.toFixed(1)} °C`,
      `${THERMAL_TYPE[worst.type] || "Sensor"} limits: warning ${worst.lim[0]} °C, failure ${worst.lim[1]} °C.`);
  }

  /* Storage and memory */
  const storage = (state.raw["Storage"] || "").split("\n")[1]?.trim().split(/\s+/);
  const used = num(storage?.[4]?.replace("%", ""));
  if (used == null) missing("Storage", "User storage");
  else add("Storage", "User storage", level(used, LIMITS.storageUsed), `${used}% used`, `${storage[2]} of ${storage[1]} on /data.`);
  const mem = state.raw["Memory"] || "";
  const mt = num(grab(mem, /MemTotal:\s+(\d+)/)), ma = num(grab(mem, /MemAvailable:\s+(\d+)/));
  if (!mt || ma == null) missing("Storage", "Free memory");
  else {
    const free = Math.round((ma / mt) * 100);
    add("Storage", "Free memory", free < LIMITS.memoryFreeMin ? "warn" : "ok", `${free}% free`, `${(ma / 1048576).toFixed(1)} of ${(mt / 1048576).toFixed(1)} GB available.`);
  }

  /* Software */
  const boot = prop("sys.boot_completed");
  if (!boot) missing("Software", "Boot", "sys.boot_completed not present.");
  else add("Software", "Boot", boot === "1" ? "ok" : "fail", boot === "1" ? "Completed" : "Not finished", "sys.boot_completed");
  const vb = prop("ro.boot.verifiedbootstate");
  if (!vb) missing("Software", "Verified boot", "ro.boot.verifiedbootstate not present.");
  else add("Software", "Verified boot", vb === "green" ? "ok" : vb === "red" ? "fail" : "warn", vb, vb === "green" ? "Firmware is signed and intact." : "Firmware is modified or the bootloader is unlocked.");
  const tags = prop("ro.build.tags"), dbg = prop("ro.debuggable");
  if (!tags && !dbg) missing("Software", "Firmware build");
  else {
    const odd = tags.includes("test-keys") || dbg === "1";
    add("Software", "Firmware build", odd ? "warn" : "ok", tags || "—", odd ? "Development or test build; not the retail firmware." : "Retail release build.");
  }
  const restarting = state.props.filter((p) => p.key.startsWith("init.svc.") && p.value === "restarting").map((p) => p.key.slice(9));
  const svc = state.props.filter((p) => p.key.startsWith("init.svc."));
  if (!svc.length) missing("Software", "System services");
  else add("Software", "System services", restarting.length ? "warn" : "ok", restarting.length ? `${restarting.length} restarting` : "Stable",
    restarting.length ? `Restarting in a loop: ${restarting.join(", ")}. Check logcat for crashes.` : `${svc.filter((p) => p.value === "running").length} running.`);

  /* Sensors */
  const sens = state.raw["Sensors"] || "";
  if (!/accel|gyro|proxim|magnet/i.test(sens)) missing("Sensors", "Motion sensors", "No sensor list returned.");
  else {
    const has = (re) => re.test(sens);
    const lost = [["accelerometer", /accel/i], ["gyroscope", /gyro/i]].filter(([, re]) => !has(re)).map(([n]) => n);
    add("Sensors", "Motion sensors", lost.length ? "fail" : "ok", lost.length ? "Missing" : "Accelerometer, gyroscope", lost.length ? `Not listed: ${lost.join(", ")}.` : "Both are registered with the system. Accuracy needs the on-device test.");
    add("Sensors", "Proximity sensor", has(/proxim/i) ? "ok" : "warn", has(/proxim/i) ? "Listed" : "Not listed", "The sensor that detects the headset being worn.");
  }
  return checks;
}

function verdictOf(checks) {
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const ran = checks.filter((c) => c.status !== "na").length;
  const state_ = fails ? "fail" : warns ? "warn" : ran ? "ok" : "na";
  const title = { fail: "Not healthy", warn: "Needs attention", ok: "Healthy", na: "Not enough data" }[state_];
  const parts = [];
  if (fails) parts.push(`${fails} ${fails === 1 ? "failure" : "failures"}`);
  if (warns) parts.push(`${warns} ${warns === 1 ? "warning" : "warnings"}`);
  if (!fails && !warns && ran) parts.push("All checks passed");
  parts.push(`${ran} of ${checks.length} checks ran`);
  return { state: state_, title, line: parts.join(" · ") };
}

function summaryText(checks, v) {
  const out = [
    "VR Expert diagnostics",
    `Model: ${prop("ro.product.model") || "—"}   Serial: ${prop("ro.serialno") || state.serial || "—"}`,
    `Firmware: ${prop("ro.build.display.id") || "—"}   Android ${prop("ro.build.version.release") || "—"}`,
    `Result: ${v.title} (${v.line})`,
    state.sample ? "(SAMPLE DATA)" : "",
    "",
  ];
  for (const c of checks.filter((c) => c.status === "fail" || c.status === "warn")) {
    out.push(`${c.status === "fail" ? "FAIL" : "WARN"}  ${c.name}: ${c.value}. ${c.detail}`);
  }
  return out.join("\n").trim();
}

const GLYPH = { ok: "✓", warn: "!", fail: "✕", na: "–" };

function checkRow(c, compact) {
  return el("div", { class: "check" + (compact ? " compact" : ""), "data-s": c.status },
    el("span", { class: "g", text: GLYPH[c.status] }),
    el("span", { class: "n", text: c.name }),
    el("span", { class: "val", text: c.value }),
    c.detail ? el("span", { class: "d", text: c.detail }) : null);
}

function renderOverview() {
  const o = $("overview");
  if (!state.props.length) {
    o.replaceChildren(el("div", { class: "empty" },
      el("h1", { text: "Check a headset" }),
      el("p", { text: "Connect a Pico over USB to run the health check. USB debugging must be enabled on the headset." }),
      el("button", { class: "btn primary", text: "Connect headset", onclick: connect }),
      el("p", { style: "margin:14px 0 0" }, el("button", { class: "link", text: "Try with sample data", onclick: loadSample }))));
    return;
  }
  const checks = computeChecks();
  const v = verdictOf(checks);
  const attention = checks.filter((c) => c.status === "fail" || c.status === "warn").sort((a, b) => (a.status === "fail" ? 0 : 1) - (b.status === "fail" ? 0 : 1));
  const passed = checks.filter((c) => c.status === "ok");
  const unknown = checks.filter((c) => c.status === "na");

  const copyBtn = el("button", { class: "btn", text: "Copy summary", onclick: (e) => copy(summaryText(checks, v), e.target) });
  const verdict = el("section", { class: "verdict", "data-state": v.state },
    el("div", { class: "mark", text: { ok: "✓", warn: "!", fail: "✕", na: "?" }[v.state] }),
    el("div", {}, el("h1", { text: v.title }), el("p", { text: v.line })),
    copyBtn);

  const left = el("div", {});
  if (attention.length) left.append(el("section", {}, el("h2", { text: "Needs attention" }), ...attention.map((c) => checkRow(c))));
  if (passed.length) left.append(el("section", {}, el("h2", { text: "Passed" }), ...passed.map((c) => checkRow(c, true))));
  if (unknown.length) left.append(el("section", {}, el("h2", { text: "No data" }), ...unknown.map((c) => checkRow(c))));

  const dl = el("dl", { class: "kv" });
  const info = [
    ["Model", prop("ro.product.model")], ["Manufacturer", prop("ro.product.manufacturer")],
    ["Serial", prop("ro.serialno") || state.serial], ["Firmware", prop("ro.build.display.id")],
    ["Android", prop("ro.build.version.release") && `${prop("ro.build.version.release")} (API ${prop("ro.build.version.sdk")})`],
    ["Security patch", prop("ro.build.version.security_patch")],
    ["Built", interpret("ro.build.date.utc", prop("ro.build.date.utc"))],
    ["Platform", prop("ro.board.platform") || prop("ro.hardware")], ["Bootloader", prop("ro.bootloader")],
  ];
  for (const [k, val] of info) if (val) dl.append(el("dt", { text: k }), el("dd", { text: val }));

  o.replaceChildren(verdict,
    el("div", { class: "cols" }, left, el("aside", {}, el("h2", { text: "Device", style: "font-size:15px;margin-bottom:10px" }), dl)),
    el("p", { class: "scope", text: "These are software-level checks read over ADB. Cameras, tracking, controllers, display and audio need the on-device test app, which is not built yet." }));
}

function renderRaw() {
  const r = $("raw");
  const names = Object.keys(state.raw);
  if (!names.length) { r.replaceChildren(el("div", { class: "msg", text: "Command output appears here after connecting." })); return; }
  r.replaceChildren(...names.map((n) => el("details", {}, el("summary", { text: `${n}` }), el("pre", { text: state.raw[n] || "(no output)" }))));
}

function renderAll() {
  renderDevice(); renderCats(); renderRows(); renderDrawer(); renderOverview(); renderRaw();
  $("exp-json").disabled = $("exp-csv").disabled = !state.props.length;
}

/* ---------- ADB ---------- */

async function sh(cmd) {
  return (await state.adb.subprocess.noneProtocol.spawnWaitText(cmd)).trim();
}

async function connect() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) return setStatus("This browser does not support WebUSB. Use Chrome or Edge.", "err");
  try {
    setStatus("", "busy");
    const device = await manager.requestDevice();
    if (!device) return setStatus("");
    setStatus("", "busy");
    let connection;
    try {
      connection = await device.connect();
    } catch (e) {
      return setStatus(
        "Could not open the USB interface. Usual causes: another ADB server is running (run `adb kill-server`, close SideQuest / Android Studio) or the WinUSB driver is missing. Details: " + e, "err");
    }
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial, connection, credentialStore: new AdbWebCredentialStore("Pico Bench"),
    });
    state.adb = new Adb(transport);
    state.serial = device.serial;
    state.sample = false;
    $("refresh").disabled = false;
    await readAll();
  } catch (e) {
    setStatus("Error: " + e, "err");
  }
}

async function readAll() {
  if (!state.adb) return;
  setStatus("", "busy");
  state.props = parseGetprop(await sh("getprop"));
  state.raw = {};
  renderAll();
  for (const [label, cmd] of RAW_COMMANDS) {
    setStatus("", "busy");
    try { state.raw[label] = await sh(cmd); } catch (e) { state.raw[label] = "Error: " + e; }
  }
  renderAll();
  setStatus("");
}

function loadSample() {
  state.adb = null;
  state.sample = true;
  state.serial = "SAMPLE0000";
  state.props = parseGetprop(SAMPLE_PROPS);
  state.raw = { ...SAMPLE_RAW };
  $("refresh").disabled = true;
  renderAll();
  setStatus("");
}

/* ---------- export ---------- */

function download(name, text, type) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const stamp = () => `${prop("ro.serialno") || state.serial || "headset"}-${new Date().toISOString().slice(0, 10)}`;

/* ---------- wiring ---------- */

$("connect").onclick = connect;
$("refresh").onclick = () => readAll().catch((e) => setStatus("Error: " + e, "err"));
$("q").addEventListener("input", (e) => { state.q = e.target.value; renderRows(); });
$("kinds").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.kind = b.dataset.kind;
  for (const x of $("kinds").children) x.setAttribute("aria-pressed", String(x === b));
  renderRows();
});
document.querySelectorAll("nav [data-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav [data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "v-" + b.dataset.tab));
}));
$("exp-json").onclick = () =>
  download(`props-${stamp()}.json`, JSON.stringify({ date: new Date().toISOString(), sample: state.sample, properties: Object.fromEntries(state.props.map((p) => [p.key, p.value])), raw: state.raw }, null, 2), "application/json");
$("exp-csv").onclick = () => {
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  download(`props-${stamp()}.csv`, ["key,value,category", ...state.props.map((p) => [p.key, p.value, p.cat].map(esc).join(","))].join("\n"), "text/csv");
};
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== $("q")) { e.preventDefault(); $("q").focus(); }
  if (e.key === "Escape") { if (document.activeElement === $("q") && state.q) { $("q").value = ""; state.q = ""; renderRows(); } else select(null); }
});
if (!navigator.usb) setStatus("This browser does not support WebUSB. Use Chrome or Edge to connect a headset. ", "err");
renderAll();
