import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { SAMPLE_PROPS, SAMPLE_RAW } from "./sample.js";

const $ = (id) => document.getElementById(id);

// Read-only commands run on connect. `getprop` feeds the Properties tab.
const RAW_COMMANDS = [
  ["Battery", "dumpsys battery"],
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

function setStatus(msg, kind = "") {
  const s = $("status");
  s.textContent = msg;
  s.className = kind;
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
  side.replaceChildren(el("h4", { text: "Categories" }));
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
    if (parts.length) wrap.append(el("span", { class: "seg-dim", text: parts.join(".") + "." }));
    wrap.append(el("span", { class: "seg-last", text: last }));
  } else {
    wrap.append(...highlight(key, q));
  }
  return wrap;
}

function renderRows() {
  const rows = $("rows");
  const list = filtered();
  const q = state.q.trim();
  $("meta").textContent = state.props.length
    ? `${list.length} of ${state.props.length} properties`
    : "";
  $("c-props").textContent = state.props.length || "";
  if (!state.props.length) {
    rows.replaceChildren(
      el("div", { class: "empty" },
        el("h2", { text: "No properties loaded" }),
        el("p", { text: "Connect a headset to read every system property, or explore with sample data." }),
        el("button", { class: "btn primary", text: "Connect headset", onclick: connect }),
        el("button", { class: "btn", text: "Load sample data", onclick: loadSample }),
      ),
    );
    return;
  }
  if (!list.length) {
    rows.replaceChildren(el("div", { class: "empty" }, el("h2", { text: "No matches" }), el("p", { text: "Try a shorter search or another category." })));
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
    crumbs.append(el("span", { class: i < parts.length - 1 ? "c-dim" : "", text: s }));
    if (i < parts.length - 1) crumbs.append(el("span", { class: "c-dim", text: "." }));
  });

  const interp = interpret(p.key, p.value);
  const meaning = describe(p.key);
  const pre = prefixInfo(p.key);
  const sibs = state.props.filter((x) => x.key !== p.key && x.key.split(".").slice(0, -1).join(".") === parts.slice(0, -1).join(".")).slice(0, 14);

  const dl = el("dl");
  const row = (t, v) => v && dl.append(el("dt", { text: t }), el("dd", {}, v));
  row("Category", p.cat);
  row("Type", p.type);
  row("Scope", pre);
  row("Meaning", meaning);
  row("Length", `${p.value.length} chars`);

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
    el("h3", { text: "Property" }), crumbs,
    el("h3", { text: "Value" }),
    el("div", { class: "valbox", text: p.value === "" ? "(empty string)" : p.value }),
    interp ? el("div", {}, el("h3", { style: "margin-top:14px", text: "Interpreted" }), el("div", { class: "valbox", text: interp })) : null,
    actions, dl,
    sibs.length ? el("div", { class: "related" }, el("h3", { text: `Related · ${parts.slice(0, -1).join(".")}.*` }),
      ...sibs.map((s) => el("button", { text: `${s.key.split(".").pop()} = ${s.value || "(empty)"}`, onclick: () => select(s.key) }))) : null,
    el("button", { class: "btn ghost", style: "margin-top:14px", text: "Close", onclick: () => select(null) }),
  ].filter(Boolean));
}

/* ---------- rendering: device header, overview, raw ---------- */

function renderDevice() {
  const d = $("device");
  d.replaceChildren();
  if (!state.props.length) return;
  const chip = (k, v) => v && d.append(el("span", { class: "chip" }, `${k} `, el("b", { text: v })));
  d.append(el("span", { class: "chip" }, el("span", { class: state.adb ? "dot on" : "dot" }), state.adb ? "connected" : state.sample ? "sample" : "offline"));
  chip("model", prop("ro.product.model"));
  chip("serial", prop("ro.serialno") || state.serial);
  chip("fw", prop("ro.build.display.id"));
}

function parseBattery(t) {
  const g = (re) => t.match(re)?.[1] ?? null;
  return {
    level: g(/level:\s*(\d+)/), scale: g(/scale:\s*(\d+)/), temp: g(/temperature:\s*(-?\d+)/),
    voltage: g(/voltage:\s*(\d+)/), health: g(/health:\s*(\d+)/), status: g(/status:\s*(\d+)/),
    usb: g(/USB powered:\s*(\w+)/), ac: g(/AC powered:\s*(\w+)/),
    cycles: g(/(?:cycle count|Charge counter|mCycleCount):\s*(\d+)/i),
  };
}

const HEALTH = { 1: "Unknown", 2: "Good", 3: "Overheat", 4: "Dead", 5: "Over voltage", 6: "Failure", 7: "Cold" };
const BATTERY_STATUS = { 1: "Unknown", 2: "Charging", 3: "Discharging", 4: "Not charging", 5: "Full" };

function card(title, ...kids) { return el("div", { class: "card" }, el("h3", { text: title }), ...kids); }
function kv(pairs) {
  const dl = el("dl", { class: "kv" });
  for (const [k, v] of pairs) dl.append(el("dt", { text: k }), el("dd", { text: v || "—" }));
  return dl;
}

function renderOverview() {
  const o = $("overview");
  if (!state.props.length) {
    o.replaceChildren(el("div", { class: "empty" }, el("h2", { text: "Nothing to show yet" }), el("p", { text: "Connect a headset or load sample data." })));
    return;
  }
  const running = state.props.filter((p) => p.key.startsWith("init.svc.") && p.value === "running").length;
  const stats = el("div", { class: "stats" },
    ...[["Properties", state.props.length], ["Read-only", state.props.filter((p) => p.kind === "ro").length],
      ["Persistent", state.props.filter((p) => p.kind === "persist").length], ["Services running", running]]
      .map(([l, n]) => el("div", { class: "stat" }, el("b", { text: String(n) }), el("span", { text: l }))));

  const b = parseBattery(state.raw["Battery"] || "");
  const pct = b.level && b.scale ? Math.round((b.level / b.scale) * 100) : null;
  const battery = card("Battery",
    pct == null ? el("p", { text: "No battery data.", class: "mono" }) : el("div", {},
      el("div", { class: "big" }, String(pct), el("small", { text: "%" })),
      el("div", { class: `bar ${pct < 20 ? "low" : pct < 40 ? "mid" : ""}` }, el("i", { style: `width:${pct}%` })),
      kv([
        ["Status", BATTERY_STATUS[b.status] || b.status],
        ["Health", HEALTH[b.health] || b.health],
        ["Temperature", b.temp ? (b.temp / 10).toFixed(1) + " °C" : null],
        ["Voltage", b.voltage ? b.voltage + " mV" : null],
        ["USB / AC power", `${b.usb ?? "—"} / ${b.ac ?? "—"}`],
      ])));

  const identity = card("Identity", kv([
    ["Model", prop("ro.product.model")], ["Manufacturer", prop("ro.product.manufacturer")],
    ["Device", prop("ro.product.device")], ["Serial", prop("ro.serialno") || state.serial],
    ["Android", prop("ro.build.version.release")], ["API level", prop("ro.build.version.sdk")],
    ["Security patch", prop("ro.build.version.security_patch")], ["Firmware", prop("ro.build.display.id")],
    ["Built", interpret("ro.build.date.utc", prop("ro.build.date.utc"))],
  ]));

  const hw = card("Platform", kv([
    ["Hardware", prop("ro.hardware")], ["SoC platform", prop("ro.board.platform")],
    ["CPU ABI", prop("ro.product.cpu.abi")], ["Bootloader", prop("ro.bootloader")],
    ["Verified boot", prop("ro.boot.verifiedbootstate")], ["Build type", prop("ro.build.type")],
    ["Debuggable", prop("ro.debuggable")], ["Display density", prop("ro.sf.lcd_density") && prop("ro.sf.lcd_density") + " dpi"],
  ]));

  const mem = state.raw["Memory"] || "";
  const kb = (n) => mem.match(new RegExp(n + ":\\s+(\\d+)"))?.[1];
  const total = kb("MemTotal"), avail = kb("MemAvailable");
  const storage = (state.raw["Storage"] || "").split("\n")[1]?.trim().split(/\s+/);
  const resources = card("Resources", kv([
    ["RAM total", total ? (total / 1048576).toFixed(1) + " GB" : null],
    ["RAM available", avail ? (avail / 1048576).toFixed(1) + " GB" : null],
    ["/data size", storage?.[1]], ["/data used", storage ? `${storage[2]} (${storage[4]})` : null],
  ]));

  o.replaceChildren(stats, el("div", { class: "grid" }, identity, battery, hw, resources));
}

function renderRaw() {
  const r = $("raw");
  const names = Object.keys(state.raw);
  $("c-raw").textContent = names.length || "";
  if (!names.length) { r.replaceChildren(el("div", { class: "empty" }, el("h2", { text: "No output yet" }), el("p", { text: "Command output appears here after connecting." }))); return; }
  r.replaceChildren(...names.map((n) => el("details", {}, el("summary", { text: `${n}` }), el("pre", { text: state.raw[n] || "(no output)" }))));
}

function renderAll() {
  renderDevice(); renderCats(); renderRows(); renderDrawer(); renderOverview(); renderRaw();
  $("exp-json").disabled = $("exp-csv").disabled = !state.props.length;
  $("banner").hidden = !state.sample;
}

/* ---------- ADB ---------- */

async function sh(cmd) {
  return (await state.adb.subprocess.noneProtocol.spawnWaitText(cmd)).trim();
}

async function connect() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) return setStatus("This browser does not support WebUSB. Use Chrome or Edge.", "err");
  try {
    setStatus("Pick the headset in the browser prompt…");
    const device = await manager.requestDevice();
    if (!device) return setStatus("No device selected.", "err");
    setStatus("Opening USB… If the headset asks, tap “Allow USB debugging”.");
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
  setStatus("Reading getprop…");
  state.props = parseGetprop(await sh("getprop"));
  state.raw = {};
  renderAll();
  for (const [label, cmd] of RAW_COMMANDS) {
    setStatus(`Running ${cmd}…`);
    try { state.raw[label] = await sh(cmd); } catch (e) { state.raw[label] = "Error: " + e; }
  }
  renderAll();
  setStatus(`Done. ${state.props.length} properties read from ${prop("ro.product.model") || state.serial}.`, "ok");
}

function loadSample() {
  state.adb = null;
  state.sample = true;
  state.serial = "SAMPLE0000";
  state.props = parseGetprop(SAMPLE_PROPS);
  state.raw = { ...SAMPLE_RAW };
  $("refresh").disabled = true;
  renderAll();
  setStatus("Showing sample data. Connect a headset to read real values.", "");
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
$("sample").onclick = loadSample;
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
if (!navigator.usb) setStatus("This browser does not support WebUSB. Use Chrome or Edge to connect a headset. Sample data still works.", "err");
renderAll();
