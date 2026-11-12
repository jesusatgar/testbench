import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const out = $("out");
const summary = $("summary");

// Comandos de solo lectura de la prueba de concepto.
const COMMANDS = [
  ["Modelo", "getprop ro.product.model"],
  ["Fabricante", "getprop ro.product.manufacturer"],
  ["Dispositivo", "getprop ro.product.device"],
  ["Nº de serie", "getprop ro.serialno"],
  ["Versión Android", "getprop ro.build.version.release"],
  ["Build / firmware", "getprop ro.build.display.id"],
  ["Batería", "dumpsys battery"],
  ["Térmica", "dumpsys thermalservice"],
  ["Almacenamiento", "df -h /data"],
  ["Memoria", "cat /proc/meminfo"],
  ["Sensores", "dumpsys sensorservice"],
  ["Paquetes Pico", "pm list packages | grep -i pico"],
  ["Todas las propiedades", "getprop"],
];

let adb = null;
let results = {};

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

async function connect() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) {
    setStatus("Este navegador no soporta WebUSB. Usa Chrome o Edge.", "err");
    return;
  }
  setStatus("Selecciona el visor en la ventana del navegador…");
  const device = await manager.requestDevice();
  if (!device) { setStatus("No se seleccionó ningún dispositivo.", "err"); return; }

  setStatus("Abriendo USB… Si el visor lo pide, acepta «Permitir depuración USB».");
  let connection;
  try {
    connection = await device.connect();
  } catch (e) {
    setStatus(
      "No se pudo abrir la interfaz USB. Causas típicas: hay un servidor ADB abierto " +
      "(ejecuta «adb kill-server» y cierra SideQuest/Android Studio) o falta el driver WinUSB. " +
      "Detalle: " + e, "err");
    return;
  }
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore: new AdbWebCredentialStore("Via Expert Diagnostico"),
  });
  adb = new Adb(transport);
  setStatus("Conectado: " + device.serial, "ok");
  $("run").disabled = false;
}

async function sh(cmd) {
  return (await adb.subprocess.noneProtocol.spawnWaitText(cmd)).trim();
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

async function run() {
  $("run").disabled = true;
  results = {};
  out.innerHTML = "";
  for (const [label, cmd] of COMMANDS) {
    setStatus("Ejecutando: " + cmd);
    try { results[label] = { cmd, output: await sh(cmd) }; }
    catch (e) { results[label] = { cmd, error: String(e) }; }
    const det = document.createElement("details");
    const sm = document.createElement("summary");
    sm.textContent = label + "  ·  " + cmd;
    const pre = document.createElement("pre");
    pre.textContent = results[label].output ?? results[label].error;
    det.append(sm, pre);
    out.append(det);
  }
  renderSummary();
  setStatus("Diagnóstico completado.", "ok");
  $("run").disabled = false;
  $("download").disabled = false;
}

function renderSummary() {
  const bat = results["Batería"]?.output ?? "";
  const level = pick(bat, /level:\s*(\d+)/);
  const temp = pick(bat, /temperature:\s*(\d+)/);
  const volt = pick(bat, /voltage:\s*(\d+)/);
  const health = pick(bat, /health:\s*(\d+)/);
  const rows = [
    ["Modelo", results["Modelo"]?.output],
    ["Nº de serie", results["Nº de serie"]?.output],
    ["Firmware", results["Build / firmware"]?.output],
    ["Android", results["Versión Android"]?.output],
    ["Batería", level ? level + " %" : "—"],
    ["Temp. batería", temp ? (temp / 10).toFixed(1) + " °C" : "—"],
    ["Voltaje", volt ? volt + " mV" : "—"],
    ["Salud batería (código Android; 2 = buena)", health ?? "—"],
  ];
  summary.innerHTML = "";
  for (const [k, v] of rows) {
    const tr = document.createElement("tr");
    const a = document.createElement("th"); a.textContent = k;
    const b = document.createElement("td"); b.textContent = v ?? "—";
    tr.append(a, b); summary.append(tr);
  }
}

function download() {
  const serial = results["Nº de serie"]?.output || "pico";
  const blob = new Blob([JSON.stringify({ fecha: new Date().toISOString(), resultados: results }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `diagnostico-${serial}.json`;
  a.click();
}

$("connect").onclick = () => connect().catch((e) => setStatus("Error: " + e, "err"));
$("run").onclick = () => run().catch((e) => { setStatus("Error: " + e, "err"); $("run").disabled = false; });
$("download").onclick = download;
if (!navigator.usb) setStatus("Este navegador no soporta WebUSB. Usa Chrome o Edge.", "err");
