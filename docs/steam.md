# Área Steam

Módulo aislado en `src/core/steam` para leer/escribir accesos directos externos de
Steam, calcular AppIDs, copiar artwork y coordinar un cierre/reapertura de Steam.
No importa Electron, React ni la base de datos. Todo el acceso a procesos y al
registro es inyectable; los tests trabajan con directorios temporales y fixtures.

Fecha de consulta de las fuentes: **26 de octubre de 2026**.

## Qué implementa y qué no

Implementado:

- Parser y serializador determinista del VDF binario de Valve, con roundtrip y
  límites de tamaño/profundidad.
- Cálculo del AppID heredado de accesos externos y de los nombres de artwork.
- Detección de la instalación de Steam (ruta inyectada, variables, registro de
  Windows) y enumeración de cuentas desde `userdata`.
- Lectura tolerante de `config/loginusers.vdf` para asociar persona/cuenta.
- Planificación y escritura de shortcuts gestionados, con colisiones, etiquetas,
  backups y escritura atómica.
- Aplicación/limpieza/migración de artwork local.
- Orquestador de sincronización con Steam cerrado y runner auxiliar de línea de
  comandos, sin IPC de Electron.

No implementado deliberadamente:

- No mata procesos Steam. Si no se cierra a tiempo, aborta.
- No modifica el Steam real durante los tests ni en este repositorio.
- No descarga artwork desde Internet.
- No soporta el grid horizontal (`<appid>.png`) ni `screenshot`; no promete
  descripciones, campos de nube ni colecciones de Steam.
- No implementa IPC, SQLite ni UI.

## Formato `shortcuts.vdf`

`shortcuts.vdf` está en `userdata/<accountId>/config/shortcuts.vdf` y es VDF
binario (KeyValues1 binario), no JSON ni VDF de texto. La estructura real:

```
root (objeto)
└── "shortcuts" (objeto)
    ├── "0" (objeto)  → un shortcut
    │   ├── appid (int32)
    │   ├── AppName / Exe / StartDir / icon / ShortcutPath / LaunchOptions
    │   ├── IsHidden / AllowDesktopConfig / AllowOverlay / LastPlayTime (int32)
    │   └── tags (objeto con claves "0", "1", ... y valores string)
    ├── "1" ...
    └── ...
```

Tipos binarios soportados:

| Byte | Tipo | Representación |
| --- | --- | --- |
| `0x00` | objeto | mapa anidado hasta `0x08` |
| `0x01` | string | bytes UTF-8 terminados en NUL |
| `0x02` | int32 | 4 bytes little-endian con signo |
| `0x07` | uint64 | 8 bytes little-endian sin signo |
| `0x08` | fin de objeto | cierra el mapa actual |

Cualquier otro byte de tipo se rechaza con `STEAM_VDF_INVALID`: no se inventa una
longitud para un tipo desconocido. También se rechazan cadenas sin NUL, objetos
sin `0x08`, int32/uint64 truncados, bytes después del objeto raíz y archivos
vacíos.

Límites por defecto (`VDF_DEFAULT_LIMITS`):

- 16 MiB de archivo.
- profundidad 32.
- 200.000 entradas.
- 4 MiB por cadena.

### Preservación y determinismo

El modelo conserva:

- el orden de las entradas y de los campos;
- los bytes originales de claves y cadenas (incluido UTF-8 inválido);
- los tipos (`int32`/`uint64`) y los valores de campos desconocidos.

`parseShortcutsVdf(buffer)` devuelve el objeto **raíz** (con la entrada
`"shortcuts"`), no solo el hijo. Para obtener el contenedor:

```ts
const root = parseShortcutsVdf(buffer)
const shortcuts = getShortcutsContainer(root)
```

`serializeShortcutsVdf(root)` serializa y vuelve a parsear para comprobar que el
resultado coincide con el modelo. Un parseo seguido de serialización sin cambios
produce exactamente los mismos bytes que el fixture. Al actualizar una entrada
gestionada se reutilizan los nodos de los campos no gestionados; las entradas
ajenas no se reconstruyen. Steam puede sanear/reordenar el archivo en el
siguiente arranque; esa parte queda fuera de nuestro control.

## AppID de un acceso externo

La fórmula comunitaria heredada es:

```text
AppID32 = crc32_ieee(Exe_field + AppName) | 0x80000000
```

`Exe_field` es la cadena **exacta** guardada en el VDF, normalmente con comillas
dobles. El AppID resultante se escribe como `int32` con signo en `shortcuts.vdf`
y se usa **sin signo** en los nombres de artwork.

Vector verificado con una implementación de referencia y con `zlib.crc32`:

```text
Exe_field = "\"/usr/bin/kodi\""
AppName   = "Kodi"
AppID     = 2443196458  (0x91A0382A)
int32     = -1851770838
```

La fórmula y el vector aparecen en
<https://github.com/MasonRhodesDev/steam-notes/blob/main/shortcut-appids.md> y la
implementación original en
<https://github.com/scottrice/Ice/blob/7130b54c8d2fa7d0e2c0994ca1f2aa3fb2a27ba9/ice/steam_grid.py>
(`target + name`, CRC32 reflejado, `| 0x80000000`).

### Advertencia importante sobre Steam actual

La fórmula anterior sirve para **proponer** un AppID al crear una entrada
offline, pero no debe usarse para identificar entradas existentes:

- Hay evidencia comunitaria de que las versiones modernas de Steam asignan un
  AppID opaco al crear un acceso desde la interfaz/API y de que pueden
  reasignarlo si hay colisión. Ejemplos:
  <https://github.com/dahui/griddle/blob/main/crates/griddle-core/src/appid.rs> y
  <https://github.com/MasonRhodesDev/steam-notes/blob/main/shortcut-appids.md>.
- Por eso la app **siempre lee el `appid` guardado** en el VDF para entradas
  existentes y lo conserva a través de renombrados.
- Al crear una entrada nueva se usa la fórmula heredada; si el AppID ya está
  ocupado por cualquier entrada, se usa un hash de respaldo determinista con sal
  (`gameId`) y se registra un warning. Ese respaldo **no es el algoritmo de
  Steam**; solo evita pisar un AppID ajeno.
- Si Steam reasigna el AppID de una entrada, el siguiente plan detectará la
  colisión por nombre/Exe con la entrada antigua y se detendrá para que el
  coordinador reconcilie la referencia. No adopta la entrada por nombre.

El ID de 64 bits (`(appid << 32) | 0x02000000`) se calcula solo para
`steam://rungameid/...` y utilidades heredadas. **No** se usa para nombrar el
artwork actual.

## Artwork

Directorio: `userdata/<accountId>/config/grid/`. Nombres usados por el cliente
para shortcuts externos (AppID de 32 bits sin signo):

| Tipo | Nombre | Tamaño recomendado |
| --- | --- | --- |
| Portrait / vertical | `<appid>p.<ext>` | 600×900 |
| Hero | `<appid>_hero.<ext>` | 1920×620 o 3840×1240 |
| Logo | `<appid>_logo.<ext>` | variable, PNG con transparencia |
| Icon | `<appid>_icon.<ext>` | 256×256 |

Ejemplo para el AppID del vector: `2443196458p.png`,
`2443196458_hero.png`, `2443196458_logo.png`, `2443196458_icon.png`.

Fuentes de los nombres: gamehub
(<https://github.com/epurn/gamehub/blob/main/docs/steam-integration.md>),
steam-notes (<https://github.com/MasonRhodesDev/steam-notes/blob/main/shortcut-appids.md>)
y steam-nonsteam-art
(<https://github.com/Wonhochoi123/steam-nonsteam-art>). El nombre del portrait
lleva `p` sin guion bajo; el grid horizontal (sin sufijo) no está implementado.

- Se aceptan `.png`, `.jpg` y `.jpeg`; `.jpeg` se normaliza a `.jpg` en el
  destino. WebP/TGA/ICO no se prometen (SteamGridDB menciona WebP para algunos
  assets, pero no está verificado en este proyecto:
  <https://www.steamgriddb.com/faq>).
- El archivo de origen no se mueve ni se borra. Debe estar fuera de `grid`.
- Solo se escriben nombres canónicos de AppIDs gestionados. Antes de reemplazar
  un destino distinto se puede hacer backup en `<backupDir>/grid`.
- `removeManagedArtwork` solo borra los nombres canónicos de los AppIDs
  explícitamente indicados; opcionalmente exige que el SHA-256 coincida con el
  artwork gestionado (`expectedHashes`). No usa globs.
- `migrateManagedArtwork` copia de un AppID a otro para una reasignación
  explícita; `removeOld` es opt-in y también hace backup.

## Perfiles y detección

### Instalación

`detectSteamRoot` prueba, en orden:

1. `steamRoot` inyectado.
2. `STEAM_PATH`, `STEAM_ROOT`, `STEAM_COMPAT_CLIENT_INSTALL_PATH`.
3. `HKCU\Software\Valve\Steam\SteamExe` (de ahí se deriva la raíz).
4. Registro `HKLM\SOFTWARE\Valve\Steam\InstallPath` (vistas 32/64) y
   `HKCU\Software\Valve\Steam\SteamPath`.
5. Rutas habituales de Windows (`Program Files (x86)`, `Program Files`,
   `LOCALAPPDATA`) y de macOS/Linux.

En producción Windows se usa `reg.exe` directamente, sin addons nativos. El
registro se puede sustituir por un snapshot o desactivar con
`disableRegistry: true`; los tests nunca leen el registro real. Referencia de las
claves y vistas:
<https://github.com/osztenkurden/steam-game-path/blob/master/docs/windows-registry.md>.

### Cuentas

`userdata` contiene directorios con el **accountId de 32 bits**, no el SteamID64
ni el nombre de la persona. Se ignoran directorios no numéricos o con pinta de
SteamID64. La conversión usada es:

```text
SteamID64 = 76561197960265728 + accountId
```

Fuentes: <https://developer.valvesoftware.com/wiki/SteamID> y
<https://github.com/sonic2kk/steamtinkerlaunch/wiki/SteamUserID>.

`config/loginusers.vdf` se lee con un parser de texto tolerante (objetos,
cadenas y comentarios de línea). Si está corrupto, se devuelven las cuentas sin
persona y un warning. La cuenta activa se deduce de `mostrecent` y, si no hay
ninguno marcado, del `Timestamp` más reciente. Formato de ejemplo:
<https://github.com/warrickct/Automatic-SteamVR-Boot/blob/master/loginusers%20-%20offline.vdf>.

### Steam en ejecución

`createSteamProcessProbe` usa `tasklist` en Windows y `pgrep` en macOS/Linux.
`detectSteamStatus` acepta `running` o `processProbe` inyectados. El orquestador
recibe `isSteamRunning` como dependencia; los tests usan una sonda falsa.

## Gestión de shortcuts

### Propiedad

Un shortcut gestionado se identifica **solo** por la referencia persistida
`{ gameId, appId }` que pasa el coordinador. Nunca se adopta por nombre ni por
ruta. `planShortcutChanges` devuelve:

- `changes`: `add`, `update`, `unchanged` o `conflict`;
- `collisions`: colisiones por AppID, nombre o `Exe`;
- `managedRefs`: referencias que el coordinador debe guardar;
- `warnings`.

Si el AppID de una referencia no existe pero hay una entrada ajena con el mismo
nombre/Exe, se devuelve `conflict`; no se duplica. Si existe una entrada con el
AppID gestionado, se actualiza esa entrada.

### Campos

Se gestionan: `AppName`, `Exe`, `StartDir`, `LaunchOptions`, `icon` y `tags`.
No se prometen descripción, `sortas`, colecciones de nube ni otros campos.

- `Exe`, `StartDir` e `icon` se guardan entre comillas dobles. La convención
  comunitaria y las implementaciones de referencia guardan `"C:\...\juego.exe"`
  y `"C:\...\carpeta"`; Steam también acepta rutas sin comillas según la
  documentación de Valve, por lo que la elección de comillas es deliberada y no
  se ha probado contra un cliente real en este proyecto.
- `LaunchOptions` se guarda tal cual, sin comillas añadidas.
- Las entradas nuevas escriben además `appid`, `ShortcutPath` vacío, `IsHidden=0`,
  `AllowDesktopConfig=1`, `AllowOverlay=1`, `LastPlayTime=0` y `tags`. Steam
  completa los campos que falten.
- `tags` se fusionan por defecto (`merge`): se conservan las etiquetas existentes
  y se añaden las deseadas. `tagMode: 'replace'` sustituye la lista. Las
  etiquetas se deduplican sin distinguir mayúsculas.

### Renombrados y colisiones

- Estrategia preferida: **el AppID no cambia** al renombrar el juego o el
  ejecutable. Se actualiza la entrada existente en su sitio y el artwork sigue
  usando el mismo nombre.
- Si el coordinador decide cambiar el AppID, debe hacerlo explícitamente:
  retirar el shortcut antiguo con `removeManagedShortcuts`, migrar el artwork con
  `migrateManagedArtwork` y añadir el nuevo. Nada de esto se infiere por nombre.
- Una colisión con una entrada ajena se informa y no se modifica ni se duplica.
  `applyShortcutPlan` se niega a aplicar un plan con conflictos salvo que se pida
  explícitamente `allowConflicts`, cosa que el orquestador no hace.
- Retirar un shortcut solo es posible con `removeManagedShortcuts`, que recibe
  referencias persistidas y opcionalmente nombre/Exe esperados. Nunca borra por
  coincidencia de nombre.

### Escritura segura

`writeShortcutsAtomic`:

1. Lee el archivo actual y, si se pasa `expectedSha256`, comprueba que no cambió
   desde el plan (si cambió: `STEAM_BUSY`).
2. Crea un backup con timestamp y sufijo aleatorio en `backupDir`, con
   `COPYFILE_EXCL`, fsync y verificación SHA-256. Si el backup falla, no escribe.
3. Serializa y valida el roundtrip.
4. Escribe un temporal en el mismo directorio, hace fsync y rename atómico.
5. Relee el archivo, comprueba hash y estructura; si falla, restaura el backup.
6. Devuelve el `backupPath` para que el estado lo registre.

Los backups no se borran automáticamente. La restauración también se intenta si
la escritura falla a mitad. Si no había archivo original y la validación falla,
solo se elimina el destino si su hash es exactamente el que acabamos de escribir.

## Sincronización con Steam cerrado

`runSteamSync(job, { deps })`:

1. Valida el trabajo (rutas absolutas, cuenta, refs, artwork) y escribe estado
   inicial `running` en `statePath`.
2. Comprueba que la cuenta existe en `userdata`; si no, falla sin cerrar Steam.
3. Si Steam está en ejecución, pide un cierre **normal** con
   `steam.exe -shutdown` y espera a que desaparezca el proceso.
4. Si no cierra en `shutdownTimeoutMs` (30 s por defecto), escribe `aborted` con
   `STEAM_SHUTDOWN_FAILED`, **no mata Steam**, no toca archivos y no lo relanza.
5. Lee `shortcuts.vdf`, planifica, aplica, escribe con backup y luego aplica el
   artwork. Solo acepta artwork cuyo AppID pertenezca a un `managedRef` del plan.
   Un fallo de artwork después de escribir shortcuts deja el backup y el estado
   `failed` con `retryable: true`.
6. Reabre Steam en Big Picture con `steam.exe -bigpicture` si corresponde
   (`reopen: 'if-closed'` por defecto; también `always`/`never`). Si la
   reapertura falla, el estado sigue `completed` y se registra `reopenError`.
7. Escribe el estado final de forma atómica.

Estados: `running`, `completed`, `failed`, `aborted`. El estado incluye
`backupPath`, `appliedGameIds`, `managedAppIds`, `collisions`, `plannedChanges`,
`error`, `reopenError`, `retryable`, `warnings` y una copia del `job` para
reintentar. `steamSyncStateToResult` lo adapta a `SteamSyncResult`.

### Comandos de Steam

- `-shutdown`: documentado como “Shuts down (exits) Steam” en
  <https://developer.valvesoftware.com/wiki/Command_line_options_(Steam)>.
- `-bigpicture`: documentado como “Start in Steam Big Picture mode” en la misma
  página.
- Alternativas de protocolo documentadas: `steam://exit` y
  `steam://open/bigpicture` en
  <https://developer.valvesoftware.com/wiki/Steam_browser_protocol>.

Se eligió `steam.exe -shutdown` / `-bigpicture` por ser opciones directas del
ejecutable y no depender del manejador del protocolo `steam://`. **No se ha
probado en un Windows real con Steam abierto**; en tests se inyectan las sondas y
los comandos nunca se ejecutan.

### Worker sin Electron

`src/core/steam/worker-cli.ts`:

```bash
npx tsx src/core/steam/worker-cli.ts <trabajo.json> <estado.json>
```

- `runSteamSyncWorker({ jobPath, statePath, deps? })` lee el JSON, fuerza
  `statePath` al argumento y escribe el estado.
- Códigos de salida: `0` completado, `2` abortado/uso incorrecto, `1` fallido o
  JSON inválido.
- El JSON de trabajo usa la forma `SteamSyncJob`: `id`, `steamRoot`, `steamExe`,
  `accountId`, `desired`, `managedRefs`, `artwork`, `backupDir`, `statePath`,
  `shutdownTimeoutMs`, `shutdownPollIntervalMs`, `reopen`, `tagMode`, `dryRun`.
- Un JSON inválido deja un archivo de estado de fallo con
  `VALIDATION_ERROR`; nunca lanza sin dejar rastro.
- El runner no importa Electron, React ni la base de datos.

## Integración sugerida en Electron/SQLite

El coordinador decide cuándo sincronizar y persiste las referencias. Un flujo
mínimo:

```ts
import {
  applyArtwork,
  detectSteamStatus,
  planShortcutChanges,
  readAccountShortcuts,
  runSteamSync,
  writeAccountShortcutsAtomic
} from '@core/steam'

const status = await detectSteamStatus({ selectedAccountId })
if (!status.installed) { /* avisar */ }

const snapshot = await readAccountShortcuts(status.steamPath!, accountId)
const plan = planShortcutChanges(snapshot.root, desired, managedRefs)
// Persistir plan.managedRefs (gameId -> appId) antes o después de aplicar.
// plan.changes con action 'conflict' no deben aplicarse.

const applied = applyShortcutPlan(snapshot.root, plan)
await writeAccountShortcutsAtomic(status.steamPath!, accountId, applied.root, {
  backupDir,
  expectedSha256: snapshot.sha256 ?? null
})
await applyArtwork(status.steamPath!, accountId, artworkItems, { backupDir })
```

Para el flujo completo con cierre/reapertura, el coordinador debe lanzar
`runSteamSync` (o el worker) y, al terminar, guardar
`state.managedAppIds` y `state.backupPath`. Si `state.status` es `failed` o
`aborted`, el trabajo queda en `state.job` y puede reintentarse; no se debe
inventar una referencia nueva ni borrar backups.

## Supuestos y limitaciones reales

- **No probado contra Steam real** en esta máquina: no se abrió Steam, no se
  modificó `%ProgramFiles(x86)%\Steam\userdata`, no se ejecutó ningún cierre ni
  reapertura. Todos los tests son offline y usan fixtures temporales.
- El formato binario y los nombres de artwork se basan en documentación
  comunitaria e implementaciones de referencia; Valve no publica un contrato
  estable de `shortcuts.vdf`.
- Las comillas en `Exe`/`StartDir`/`icon` son la convención que usan las
  implementaciones consultadas. No se ha verificado en un cliente Windows real.
- Que Steam respete un AppID escrito a mano si no colisiona es una observación
  comunitaria, no una garantía oficial; puede reasignarlo.
- El artwork se copia sin validar dimensiones, contenido ni transparencia; no se
  redimensiona ni convierte. Solo se comprueban extensión, tamaño y bytes.
- El parser de `loginusers.vdf` es deliberadamente parcial; no interpreta
  condicionales ni todos los escapes de KeyValues.
- La detección real usa `reg.exe` y `tasklist`; en entornos con políticas que los
  bloqueen, `detectSteamRoot` devuelve warnings y puede quedar `installed:false`.
- Las etiquetas de Steam y el orden de campos pueden ser reescritos por Steam al
  arrancar; nuestra preservación aplica al archivo que escribimos.
- No se gestionan shortcuts de nube/remotos ni colecciones de Steam.
- Un AppID de respaldo por colisión no es el que Steam elegiría; puede provocar
  que Steam reasigne la entrada. Se elige para no pisar entradas ajenas.

## Fuentes

Consultadas el 26/10/2026:

- Valve Developer Community, *Binary VDF*:
  <https://developer.valvesoftware.com/wiki/Binary_VDF>
- Valve Developer Community, *Add Non-Steam Game*:
  <https://developer.valvesoftware.com/wiki/Add_Non-Steam_Game>
- Valve Developer Community, *Steam browser protocol*:
  <https://developer.valvesoftware.com/wiki/Steam_browser_protocol>
- Valve Developer Community, *Command line options (Steam)*:
  <https://developer.valvesoftware.com/wiki/Command_line_options_(Steam)>
- Valve Developer Community, *SteamID*:
  <https://developer.valvesoftware.com/wiki/SteamID>
- Steam Support, *Steam Cloud* (ubicación de `userdata`):
  <https://help.steampowered.com/en/faqs/view/68D2-35AB-09A9-7678>
- Corecii, *steam-binary-vdf-ts* (estructura, campos por defecto, saneado):
  <https://github.com/Corecii/steam-binary-vdf-ts>
- CorporalQuesadilla, *Steam-Shortcut-Manager wiki*:
  <https://github.com/CorporalQuesadilla/Steam-Shortcut-Manager/wiki/Steam-Shortcuts-Documentation>
- Scott Rice, *Ice* (`steam_grid.py`, CRC32):
  <https://github.com/scottrice/Ice/blob/7130b54c8d2fa7d0e2c0994ca1f2aa3fb2a27ba9/ice/steam_grid.py>
- MasonRhodesDev, *steam-notes* (AppID, vector Kodi, re-key):
  <https://github.com/MasonRhodesDev/steam-notes/blob/main/shortcut-appids.md>
- dahui, *griddle* (AppID con/sin signo, filename real):
  <https://github.com/dahui/griddle/blob/main/crates/griddle-core/src/appid.rs>
- epurn, *gamehub* (artwork por AppID sin signo):
  <https://github.com/epurn/gamehub/blob/main/docs/steam-integration.md>
- Wonhochoi123, *steam-nonsteam-art* (nombres y tamaños):
  <https://github.com/Wonhochoi123/steam-nonsteam-art>
- SteamGridDB FAQ (formatos de imagen):
  <https://www.steamgriddb.com/faq>
- osztenkurden, *steam-game-path* (registro de Windows):
  <https://github.com/osztenkurden/steam-game-path/blob/master/docs/windows-registry.md>
- sonic2kk, *SteamTinkerLaunch* (userdata con ID de 32 bits):
  <https://github.com/sonic2kk/steamtinkerlaunch/wiki/SteamUserID>
- Ejemplo de `loginusers.vdf`:
  <https://github.com/warrickct/Automatic-SteamVR-Boot/blob/master/loginusers%20-%20offline.vdf>


## Integración en la aplicación

El proceso principal usa `SteamService` (src/main/steam-service.ts) y el
repositorio SQLite `steam_shortcuts`/`steam_syncs`:

- Las referencias gestionadas se guardan por `(account_id, game_id)`; cambiar de
  cuenta no borra ni reutiliza el AppID de otra cuenta.
- La pantalla de Steam calcula los cambios pendientes contra el `shortcuts.vdf`
  del perfil seleccionado y no ofrece sincronizar si hay conflictos.
- La sincronización se confirma en la UI, se escribe un job JSON, se crea la fila
  en `steam_syncs` y se lanza el worker desacoplado. La app se cierra para que
  Steam pueda cerrarse de forma normal.
- Al volver a abrir, se lee el estado del worker y se actualizan las referencias,
  el resultado y el estado de cada juego. Si un estado `running` queda huérfano,
  se marca fallido tras el timeout de estado y se permite reintentar.
- El icono del acceso se genera desde el artwork elegido y el resto de imágenes
  se aplican en `config/grid` con los nombres canónicos del AppID.

Los tests de integración del servicio usan un Steam root temporal, una cuenta
ficticia y dependencias de ciclo de vida simuladas; no tocan el Steam real.
