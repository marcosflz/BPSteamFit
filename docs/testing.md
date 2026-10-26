# Pruebas y verificación

## Comandos

```powershell
npm install
npm run demo        # compila el setup/juego demo con csc.exe y crea el .game
npm test            # vitest (unitarias + integración local Windows)
npm run typecheck   # TypeScript estricto
npm run build       # bundle Electron
npm run dist:dir    # app empaquetada sin instalador (verificación)
npm run dist        # instalador NSIS
```

Las pruebas normales **no** necesitan Internet, claves de API, permisos de
administrador, una instalación real de Steam ni un mando físico. Usan
directorios temporales y el paquete demo reproducible.

## Cobertura actual

- **291 pruebas en 42 archivos**, offline, con typecheck limpio.
- Esquema v1: campos, versiones, claves desconocidas, variables, rutas, códigos
  de salida, perfil, verificación por archivos o directorios y comparación de
  versiones.
- Seguridad de rutas: `..`, UNC, unidades, dispositivos, prefijos extendidos
  `\\?\`/`\\.\`, reservados Windows, caracteres de control/bidi, Unicode,
  contención de prefijos y destinos absolutos locales.
- Paquetes: ZIP corrupto, manifiesto ausente/inválido, setup ausente, extras en
  raíz, cifrado, symlinks, ZIP bomb/límites antes de enumerar en memoria,
  Unicode/espacios, CLI crear/validar.
- Extracción: estructura preservada, Zip Slip, symlinks, cifrado, cancelación y
  límites.
- Instalación real del demo: éxito, código de salida inesperado, reinicio
  pendiente, integridad SHA-256, confirmación de la UI, destino ocupado,
  cancelación, **exclusión de mutex ante dos instalaciones concurrentes**,
  limpieza de temporales antiguos y **proceso secundario** que escribe el
  archivo final después de que termine setup.
- Catálogo/SQLite: importación, segunda pasada sin duplicados, nuevas versiones,
  versiones instaladas vs paquete actual, conflictos del mismo ID/versión con
  hash distinto, paquete ausente y restauración con recálculo de la versión
  actual, interrupciones recuperadas.
- Flujo vertical: importar demo → instalar con setup real → verificar → estado
  `installed` → `steam_sync_pending` → revalidar. UI empaquetada probada
  manualmente incluyendo lanzamiento del juego demo.
- Steam: VDF binario, accesos ajenos, idempotencia, backups, artwork, icono ICO,
  referencias por cuenta (varias cuentas), sync concurrente bloqueada,
  recuperación de estado `running` huérfano y conflicto con accessos ajenos.
- Metadatos/artwork: mock, SGDB con respuestas simuladas, identidad ambigua,
  caché, offline, autor/atribución, imágenes, preferencia manual y actualización
  al cambiar idioma.
- UI/mando: 57 pruebas con API falsa, incluyendo selección de mando estándar
  frente a vJoy, navegación/foco, diálogos, estados y acciones reales de la API.
- Empaquetado: `electron-vite build`, app empaquetada arrancada, worker desde
  `app.asar` con `ELECTRON_RUN_AS_NODE=1` ejecutado, instalador NSIS generado.

## Verificación manual adicional

- App de desarrollo y empaquetada ejecutadas en Windows 11.
- Paquete demo importado, metadatos/artwork mock, ficha, instalación, resultado,
  log y lanzamiento del juego demo.
- Detección real de Steam y de la cuenta (sin modificar `userdata`).
- Mando XInput virtual ViGEmBus: conexión, cruceta/stick, A para abrir ficha, B
  para volver y Start para Ajustes. No es un mando físico.
- Instalador NSIS generado correctamente (no se ha instalado en una máquina
  limpia).

## Lo que NO se ha probado

- Pulsación con un **mando físico**, Steam Input y Big Picture reales. El mando
  virtual XInput valida la Gamepad API y la navegación, no el hardware ni Steam.
- Escritura sobre una instalación real de Steam (`userdata` real). Todo el
  adaptador se prueba con fixtures temporales.
- Cierre y reapertura de Steam: el orquestador se prueba con dependencias
  simuladas; el comportamiento depende de la versión de Steam instalada.
- Flujo real de SteamGridDB con clave. El proveedor se prueba con respuestas
  simuladas; sin clave no se han hecho llamadas reales.
- UAC real: el auxiliar se ha probado en modo `--no-elevate`; el escritorio
  seguro no se automatiza.
- Instalación del NSIS en una máquina limpia, firma de código y SmartScreen.

Estas limitaciones se documentan también en [known-limits.md](known-limits.md).
