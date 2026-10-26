# BPSteamFit

Aplicación de salón para Windows que cataloga e instala **paquetes `.game`
proporcionados por el usuario**, con navegación por mando, verificación real de
la instalación y preparación de accesos externos y artwork para Steam.

No descarga juegos, no incluye contenido comercial, no evita DRM, no desactiva
antivirus y no ejecuta la app completa como administrador.

## Estado

MVP funcional en Windows, con límites documentados. El flujo real (paquete →
validación → extracción → setup demo → verificación → UI → sincronización Steam)
está implementado y probado con fixtures propios. La app se ha ejecutado tanto
desde el árbol de desarrollo como empaquetada, y se ha navegado con un mando
XInput virtual además de teclado. Consulta [docs/acceptance.md](docs/acceptance.md)
para el mapa de criterios y [docs/known-limits.md](docs/known-limits.md) antes de
usar paquetes de terceros.

No se han probado contra hardware/steam real: el ciclo de cierre/escritura/reapertura
de Steam, UAC real, un mando físico/Steam Input ni una clave real de SteamGridDB.
No hay firma de código.

## Requisitos de desarrollo

- Windows 10/11 x64.
- Node.js 24+ y npm.
- Para generar el paquete demo: `csc.exe` de .NET Framework (incluido en Windows).
- No se necesita SDK de .NET, Visual Studio ni una instalación de Steam para las
  pruebas.

## Puesta en marcha

```powershell
npm install
npm run demo      # genera demo/out/ExampleQuest.game
npm test          # pruebas offline y locales
npm run typecheck
npm run dev
```

En la app, la carpeta de paquetes por defecto es:

```
%USERPROFILE%\BPSteamFit\Packages
```

Copia ahí `demo/out/ExampleQuest.game` (o usa "Importar archivo"). La app lo
detecta, lo valida y muestra la entrada con placeholders; los metadatos mock se
resuelven sin red. Instálalo con el mando o el teclado: el setup demo es inocuo,
no requiere administrador y escribe un juego WinForms de demostración.

Los juegos se instalan por defecto en:

```
%USERPROFILE%\BPSteamFit\Games\<id>
```

Ambas rutas se pueden cambiar en Ajustes. Los datos de la app (SQLite, logs,
caché, backups de Steam) viven en `%APPDATA%\BPSteamFit`.

## Formato y CLI

Un `.game` es un ZIP con `manifest.json` en la raíz y el instalador bajo
`payload/`. El manifiesto está versionado y validado; no admite scripts ni
comandos de shell.

```powershell
npm run gamepack -- validate .\MiJuego.game
npm run gamepack -- inspect .\MiJuego.game
npm run gamepack -- create --manifest .\manifest.json --payload .\payload --out .\MiJuego.game
```

Detalles completos: [docs/manifest.md](docs/manifest.md) y
[`schema/manifest.schema.json`](schema/manifest.schema.json).

## Añadir BPSteamFit a Steam (una vez)

La app es independiente de la interfaz de Steam. Para abrirla desde Big Picture:

1. Instala/compila la app (`npm run dist` genera un instalador; también puede
   ejecutarse con `npm run dev`).
2. Abre Steam en modo escritorio o Big Picture.
3. `Biblioteca` → `Añadir un juego` → `Añadir un juego que no está en Steam`.
4. Selecciona `BPSteamFit.exe` (el instalador lo deja en la carpeta elegida).
5. Renombra la entrada a `BPSteamFit` y añade el artwork que prefieras.
6. Opcional: en propiedades del acceso, activa la entrada con mando de Steam
   según tu configuración. La app usa la Gamepad API; evita configurar Steam
   Input para emular teclado/ratón, que produciría entradas duplicadas.
7. Cambia a Big Picture y lanza BPSteamFit.

La app abre a pantalla completa y no modifica archivos internos de la UI de
Steam. Los juegos instalados se añaden como accesos externos propios, no como
juegos de tienda.

## Sincronización con Steam

Los accesos externos y el artwork se preparan en la app y se aplican en una
sincronización explícita con Steam cerrado. Antes de tocar
`shortcuts.vdf`/`grid` se crea un backup; si Steam no se cierra normalmente, se
aborta sin matar procesos. La app nunca modifica accesos que no gestiona. Ver
[docs/steam.md](docs/steam.md) y los límites.

## Metadatos y artwork

Por defecto se usa un proveedor **mock offline** con arte original de
demostración. Los paquetes no necesitan imágenes ni descripciones.

Opcionalmente se puede configurar una clave de SteamGridDB en Ajustes. La clave se
guarda cifrada con DPAPI (`safeStorage`), no se registra y nunca se envía a la
interfaz. Sin clave o sin Internet, la app sigue funcionando. Ver
[docs/metadata-providers.md](docs/metadata-providers.md).

No se usa IGDB/RAWG en el MVP; SteamGridDB no proporciona descripciones y la app
no las inventa. El catálogo propio conserva los datos que Steam no muestra en un
acceso externo.

## Arquitectura

- Electron 45 + TypeScript + React + SQLite + `sharp`.
- Proceso principal modular; renderer aislado con preload mínimo y CSP.
- Sin servidor HTTP, sin servicio Windows y sin cloud.
- Motor de instalación independiente de la UI, con estado persistido y logs.
- Adaptador Steam aislado y probado con fixtures.

Ver [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md)
y [docs/ui-controller.md](docs/ui-controller.md).

## Empaquetado

```powershell
npm run dist:dir   # app descomprimida para verificar
npm run dist       # instalador NSIS por usuario
```

El resultado aparece en `release/`. El ejecutable no está firmado; SmartScreen
puede avisar. Incluye el paquete demo en `resources/demo/ExampleQuest.game`.

## Pruebas

```powershell
npm test
npm run typecheck
```

Las pruebas no necesitan Internet, claves de API, administrador, Steam real ni
mando físico. Los tests de escritura de Steam usan fixtures temporales; no se
toca el perfil real. Ver [docs/testing.md](docs/testing.md). Hay 42 archivos y
291 pruebas automáticas en la suite actual.

## Licencia y contenido

El código es un proyecto local sin licencia declarada por el momento. El arte y
el juego demo son originales y no comerciales. No se incluye ni se utiliza
contenido de terceros ni repacks.
