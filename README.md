# testbench

## Diagnóstico Pico (prueba de concepto WebUSB)

Página en `docs/` que se conecta por ADB (WebUSB) a un visor Pico y vuelca batería, térmica, sensores y propiedades del sistema. Solo lectura.

- Requiere Chrome o Edge, HTTPS (o localhost), driver WinUSB en Windows y ningún servidor ADB abierto (`adb kill-server`).
- `docs/main.js` es el bundle generado a partir de `src/main.js` con esbuild (dependencias: `@yume-chan/adb`, `@yume-chan/adb-daemon-webusb`, `@yume-chan/adb-credential-web`).
