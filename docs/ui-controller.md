# Interfaz de salón — controles, foco y límites

Documento de la interfaz de BPSteamFit (renderer React). La app está pensada para pantalla
completa en TV 1080p y para usarse con mando, sin depender del cursor.

## Pantallas y flujo

| Pantalla | Ruta interna | API principal |
| --- | --- | --- |
| Biblioteca | `library` | `getBootstrap`, `rescanPackages`, `addPackageFolder`, `importPackageFile` |
| Ficha | `game` | `launchGame`, `revalidateInstall`, `openPath`, `revealGame` |
| Instalación | `install` | `cancelOperation`, `revalidateInstall`, `openPath`, `openLogFolder`, eventos `install:progress` |
| Identidad | `identity` | `searchIdentity`, `chooseIdentity`, `clearIdentity`, `refreshMetadata` |
| Imágenes | `artwork` | `getArtworkGallery`, `selectArtwork`, `importLocalArtwork`, `resetArtwork` |
| Steam | `steam` | `getSteamStatus`, `selectSteamAccount`, `prepareSteamSync`, `startSteamSync`, `openLogFolder` |
| Ajustes | `settings` | `updateSettings`, `addPackageFolder`, `chooseInstallationRoot`, `getProviderStatus`, `setSteamGridDbKey`, `clearSteamGridDbKey`, `quit` |

La navegación entre pantallas se guarda en un historial ligero (`navigation/screens.ts`). `B`
/ `Escape` retroceden; el foco de la pantalla anterior se restaura. El botón `Start` abre Ajustes
desde cualquier pantalla y, si ya estás en Ajustes, vuelve.

Los diálogos disponibles son: confirmación de instalación con destino, cancelación de la
extracción, borrado de identidad/metadatos, sincronización de Steam, configuración/borrado de la
clave de SteamGridDB y salida de la app. Todos usan el mismo componente modal con foco atrapado.

## Mapa de controles

Se usa **solo la Gamepad API del navegador** (Chromium/Electron), mapeo estándar. No se abre
XInput ni ningún dispositivo nativo desde el renderer.

| Entrada | Índice / gesto | Acción |
| --- | --- | --- |
| A | botón 0 | Aceptar, abrir, confirmar |
| B | botón 1 | Volver, cerrar diálogo, salir de un campo de texto |
| X | botón 2 | Acción opcional de pantalla (mapeada, reservada) |
| Y | botón 3 | Acción secundaria opcional (mapeada, reservada) |
| LB | botón 4 | Pestaña/filtro anterior |
| RB | botón 5 | Pestaña/filtro siguiente |
| Start | botón 9 | Abrir Ajustes / volver desde Ajustes |
| Back | botón 8 | Volver |
| Cruceta | 12 arriba, 13 abajo, 14 izquierda, 15 derecha | Mover el foco |
| Stick izquierdo | ejes 0 y 1 | Mover el foco; zona muerta 0,3 |

- La cruceta tiene prioridad sobre el stick.
- El eje dominante decide la dirección; no se emiten dos direcciones por un diagonal.
- La dirección se repite a los **350 ms** y después cada **110 ms**. Al liberar se reinicia.
- Los botones de acción solo se emiten en el flanco de subida (sin repetición accidental).
- Al conectar un mando no se emite ninguna acción. Un botón que ya estaba pulsado al conectar
  debe soltarse y volver a pulsarse. Esto evita aceptar algo por accidente al recuperar el foco.
- Se aceptan solo mandos con `mapping === 'standard'`. Si hay varios, se prioriza el que tiene
  actividad y, si no, el último usado; nunca se combinan dos mandos. Los joysticks genéricos o
  vJoy se ignoran.

### Teclado

| Tecla | Acción |
| --- | --- |
| Flechas | Mover el foco |
| Enter / Espacio | Activar el control enfocado |
| Escape | Volver / cerrar diálogo / salir del campo de texto |
| Tab / Shift+Tab | Navegación nativa; dentro de un diálogo queda atrapada |

En campos de texto (`input`, `textarea`, `select`, contenido editable) las flechas y Enter no se
interceptan: pertenecen al campo. `Escape` o `B` sacan el foco del campo; un segundo `B` ejecuta la
acción de volver.

### Teclado en pantalla

La búsqueda de identidad incluye un teclado QWERTY reutilizable (`OnScreenKeyboard`). Al abrirlo,
el foco va a la primera tecla. Con teclado físico se puede pulsar Tab hasta el campo y escribir
directamente; Enter dentro del campo envía la búsqueda. El teclado en pantalla no se usa para la
clave de SteamGridDB: ese campo es `type="password"` y requiere teclado físico.

## Foco

La app no usa el cursor como mecanismo principal. Los controles declaran:

- `data-focusable`: participa en la navegación.
- `data-focus-id`: identificador estable para recordar/restaurar el foco.
- `data-autofocus`: control preferido al entrar en una pantalla o diálogo.

`lib/focus.ts` implementa:

1. **Geometría real**: centros de los rectángulos, distancia primaria y penalización
   perpendicular para favorecer filas/columnas. No envuelve en los bordes.
2. **Fallback sin layout**: orden DOM determinista, usado por jsdom y por pantallas sin geometría
   fiable. Los tests de navegación espacial usan rectángulos inyectados.
3. **Memoria por pantalla**: cada `focusin` dentro de una pantalla guarda su `data-focus-id`; al
   volver a esa pantalla se restaura. El historial de navegación no depende del foco del navegador.
4. **Diálogos**: el primer `[data-autofocus]` recibe el foco, Tab queda atrapado dentro del panel,
   un intento de enfocar el fondo devuelve el foco al diálogo y al cerrar se restaura el control
   anterior si sigue existiendo.
5. **Reconexión**: al detectar un mando nuevo, si el foco se perdió en `body` o fuera de la
   pantalla/diálogo activo, se enfoca el primer control útil. El teclado nunca se bloquea.
6. **Ventana enfocada**: al recuperar el foco de la ventana (por ejemplo tras un diálogo del
   sistema o un reinicio de Steam) se recupera el foco si se había perdido.

La barra superior también es navegable (marca, Steam, Ajustes). El foco inicial de la biblioteca
es la primera carátula; si no hay juegos, la acción de añadir carpeta.

## Progreso e instalación

- Los datos se actualizan con `bootstrap` y con el evento `install:progress`; no hay polling de
  instalación en el renderer.
- Solo se muestra porcentaje si `progress.indeterminate === false` y `progress.percent` es un
  número. Nunca se calcula un porcentaje a partir de bytes.
- Los bytes se muestran solo si `bytesDone`/`bytesTotal` llegan del backend.
- Durante `installing` y `verifying` la barra es indeterminada y se explica que no se inventan
  cifras.
- `Cancelar instalación` solo aparece en `validating` y `extracting`. Durante el setup se explica
  que no se fuerza el cierre del instalador; la app no mata el proceso.
- Se muestran PID, código de salida, destino, fechas y ruta de log cuando existen. El contenido
  del log no se lee; se abre la ruta o la carpeta de logs.
- Los detalles técnicos de error se filtran (`lib/errors.ts`): se ocultan claves/tokens y se
  truncan objetos. No se muestran stacks.

## Steam

- Se listan los perfiles detectados; seleccionar uno llama a `selectSteamAccount`.
- Los cambios pendientes son los que devuelve `SteamStatus.pendingChanges`; no se inventan.
- Sincronizar ejecuta `prepareSteamSync` y `startSteamSync(true)` **después** de la confirmación
  explícita. El backend programa un auxiliar desacoplado y la app se cierra para aplicarlo; el
  resultado real queda en `SteamStatus.lastResult` y se ve al volver a abrir BPSteamFit.
- El diálogo avisa de que BPSteamFit se cerrará, de que Steam se cerrará de forma normal y se
  reabrirá en Big Picture, y de que si Steam no se cierra en 30 s no se modifica nada.
- Mientras la ventana no tiene foco, el hook de mando actualiza su estado pero **no entrega
  acciones**, para no mover el foco de la app mientras el usuario está en Steam.
- Solo se muestra el `message` de `SteamSyncStartResult`; su campo `result` es `unknown` y no se
  interpreta. Si `scheduled` es verdadero no se consulta el estado inmediatamente porque la app va
  a cerrarse; si es falso se refresca con `getSteamStatus`.
- No se escribe ninguna descripción de tienda en Steam. La UI lo dice en la pantalla y en el
  diálogo.
- El backup se muestra como ruta dentro del último resultado. No hay botón para abrir la carpeta
  de backups porque `openPath` solo valida logs, instalaciones y paquetes; el enlace real
  disponible es «Abrir carpeta de logs».
- `Abrir carpeta de logs` usa `openLogFolder`. Abrir el log concreto usa `openPath(logPath, 'log')`.

## Ajustes y credenciales

- Carpetas de paquetes: lista y alta mediante el selector del sistema.
- Raíz de instalación: selector del sistema.
- Proveedor de metadatos: catálogo local o SteamGridDB; el estado viene de `ProviderStatus`.
- Preferencia de idioma de metadatos mediante `referToMetadataInSpanish`.
- Clave de SteamGridDB: campo `type=password`, sin logs, sin conservarla en React después de
  guardar. El diálogo enfoca el campo para favorecer el teclado físico; el mando puede salir con
  `B` y navegar a Cancelar/Guardar. `Tab` funciona.
- Ayuda de mapeo y aviso explícito de Steam Input.
- Versión y plataforma desde `BootstrapData`; abrir logs; salir con confirmación.

## Estructura del renderer

- `src/renderer/src/App.tsx`: bootstrap, historial de pantallas, eventos, entrada global de teclado/mando,
  diálogos y restauración de foco.
- `src/renderer/src/api/ApiContext.tsx` y `runtime/AppRuntime.ts`: inyección de `BpsApi` y estado
  compartido de solo lectura + acciones.
- `lib/gamepad.ts`: motor puro de mapeo, zona muerta y repetición.
- `hooks/useGamepad.ts`: único sondeo de la Gamepad API; connect/disconnect y pausa sin foco.
- `lib/focus.ts` + `hooks/useFocusRestore.ts`: navegación espacial, memoria y restauración de foco.
- `navigation/`: reducer de pantallas y registro de acciones de la pantalla activa.
- `components/`: cabecera, tarjetas, placeholders, progreso, modal, teclado en pantalla, toasts.
- `screens/`: Biblioteca, Ficha, Instalación, Identidad, Imágenes, Steam y Ajustes.
- `dialogs/DialogHost.tsx`: confirmaciones y credenciales.
- `styles.css`: tokens y sistema visual completo.

## Diseño visual

- La ventana Electron debe abrirse en **fullscreen**; la UI ocupa `100vh` y no dibuja barra de
  título propia. No se llama a `requestFullscreen` desde React para no competir con la ventana.
- Paleta propia: grafito/azul profundo, acento ámbar cálido, verde/rojo solo para estados.
- Tipografía de sistema: serif editorial para títulos y sans para controles. No se descargan
  fuentes.
- CSS global con tokens (`styles.css`), sin glassmorphism generalizado. Los paneles tienen
  profundidad sutil y bordes cálidos.
- Carátulas verticales en cuadrícula de 7 columnas a 1760 px o más, 6 a 1450 px, 5 a 1150 px y 4
  a 850 px; en pantallas pequeñas baja a 2–3.
- Placeholders generados con gradiente, iniciales y tipo de artwork. No se cargan imágenes
  remotas: solo se aceptan `bps-media:` o `data:image/` (`safeArtworkUrl`).
- Animaciones respetan `prefers-reduced-motion`.
- Foco visible con outline ámbar; además escala/borde en las carátulas.
- Zonas seguras de TV mediante padding generoso y tipografías grandes.

## Límites reales

1. **UAC no es controlable desde la app.** Windows abre el escritorio seguro; el mando y la
   Gamepad API no llegan ahí. Si el paquete requiere elevación, la UI avisa y sugiere ejecutar el
   setup manualmente y comprobar la instalación.
2. **Steam Input puede interceptar o remapear botones.** Si hay una capa global o un perfil de
   escritorio que emula teclado/ratón, la app puede recibir otros índices o ningún evento. Para
   probar, desactiva temporalmente la capa o usa un perfil de mando estándar. No se añade XInput
   nativo para evitar doble fuente.
3. **Solo se soporta el mapeo estándar.** Se exige `mapping === 'standard'`; VJoy o joysticks
   genéricos se ignoran. Mandos con mapeo no estándar pueden no coincidir con los índices
   A/B/LB/RB. No hay pantalla de remapeo.
4. **Solo un mando compatible controla la app a la vez.** Si hay varios, se elige el que tiene
   actividad o el último usado; no se mezclan entradas de dos mandos.
5. **La clave de SteamGridDB requiere teclado físico.** No se ofrece teclado en pantalla para
   secretos; el diálogo lo avisa.
6. **Los diálogos nativos de carpetas/archivos no los controla la app.** Son ventanas de Windows;
   pueden requerir teclado/ratón. La UI lo avisa en onboarding y destino de instalación.
7. **El foco se pausa cuando la ventana no está activa.** Esto evita robar entradas durante el
   reinicio de Steam o un diálogo del sistema. Al recuperar el foco se intenta restaurar.
8. **El sondeo usa `setTimeout` a ~60 Hz**, no `requestAnimationFrame`, para seguir funcionando
   aunque el compositor esté ocupado. Electron puede limitarlo en segundo plano; como se ignoran
   acciones sin foco, no afecta al uso normal.
9. **No hay contenido de log en la UI**, solo rutas y apertura.
10. **Steam no se inicia ni se hace login desde la app.** El contrato solo permite detectar
    perfiles y sincronizar la biblioteca de accesos.
11. **El resultado de `startSteamSync` es parcialmente opaco.** La UI muestra `message` y, si no
    hay sincronización programada, vuelve a consultar `getSteamStatus`. Si hay sync programada, la
    app se cierra para que el auxiliar aplique los cambios; no hay progreso en tiempo real y el
    resultado aparece en el siguiente arranque.
12. **La app no elimina carpetas de paquetes** desde Ajustes (solo añade). El contrato permite
    `updateSettings`, pero no hay flujo de borrado seguro implementado.
13. **No se puede abrir la carpeta de backups de Steam** con el contrato actual; se muestra la
    ruta y se ofrece la carpeta de logs. Ver contratos faltantes.
14. **La app se cierra al iniciar la sincronización de Steam.** No es una pérdida temporal de
    foco: el auxiliar desacoplado termina el trabajo y Steam se reabre según la política del
    backend. Si se lanzó desde Steam, el siguiente arranque muestra el resultado.

## Cómo probar con mando / Big Picture

### Prueba manual recomendada

1. Conecta un mando Xbox (o compatible con mapeo estándar) antes de abrir la app. Comprueba el
   indicador «Mando conectado».
2. En la biblioteca, mueve con cruceta y stick. Mantén una dirección: el foco debe avanzar tras
   350 ms y repetir cada 110 ms. Comprueba que no salta al otro extremo en un límite.
3. Abre una ficha con A. Vuelve con B. El foco debe volver a la misma carátula.
4. Entra en Ajustes con Start. Desde Ajustes, Start vuelve. Abre y cierra un diálogo con A/B y
   comprueba que Tab no saca el foco.
5. En Imágenes, cambia de categoría con LB/RB y selecciona una imagen con A.
6. En Identidad, prueba un juego sin identidad; abre el teclado en pantalla y busca con A. Prueba
   también a escribir con teclado físico mediante Tab.
7. Inicia una instalación, confirma el destino y observa la extracción. Intenta cancelar durante
   extrayendo; durante el setup no debe aparecer el botón de cancelar.
8. En Steam, prueba con Steam cerrado y con Steam abierto. Acepta la sincronización: la app se
   cerrará, pedirá a Steam un cierre ordenado y el auxiliar reabrirá Steam en Big Picture. Vuelve a
   abrir BPSteamFit y comprueba el resultado en «Último resultado» y la carpeta de logs.
9. Desconecta el mando con la app abierta: el teclado debe seguir funcionando y el indicador debe
   cambiar. Reconéctalo y comprueba que el foco vuelve.
10. Abre Ajustes → clave de SteamGridDB. Verifica que el campo está enmascarado y que solo admite
    teclado físico.

### Big Picture / Steam Input

- Añadir la app a Steam o lanzarla desde Big Picture puede activar Steam Input. Si los botones no
  coinciden, prueba con la capa de Steam Input desactivada o con un perfil «mando estándar».
- Big Picture puede reclamar el mando y el overlay de Steam; BPSteamFit no puede impedirlo. El
  teclado físico siempre es una alternativa.
- Al sincronizar, BPSteamFit se cierra para que el auxiliar cierre Steam de forma ordenada, escriba
  la biblioteca y lo reabra en Big Picture. No es una simple pérdida de foco: vuelve a abrir la app
  para ver el resultado. Mientras otra ventana tiene el foco (diálogos del sistema), la UI pausa las
  acciones de mando.
- Si usas un mando PlayStation, verifica que Chromium lo expone como `mapping: standard`; los
  índices de botones pueden variar según el driver.

## Verificación automática

Ejecutado con `npx vitest run tests/ui` (14 archivos, 56 pruebas, todas correctas al cierre de esta
implementación) y `npx tsc --noEmit -p tsconfig.json` sin errores en el renderer ni en los tests.
La suite completa del proyecto también se ejecutó: 41 archivos y 281 pruebas correctas.

Cubierto automáticamente (jsdom/offline, con un `BpsApi` falso que registra llamadas):

- Motor de mando: zona muerta, eje dominante, cruceta con prioridad, repetición 350/110, flanco de
  subida, A/B/X/Y/LB/RB/Start/Back, reconexión sin acciones fantasma, lectura del pad y selección
  de un único mando estándar (ignora vJoy/joysticks, prioriza actividad).
- Hook `useGamepad`: conexión/desconexión, emisión de A y limpieza del sondeo al desmontar.
- Integración mando→app: A sobre una carátula abre la ficha y B vuelve restaurando el foco.
- Foco: geometría, alineación, límites, fallback DOM, memoria por pantalla, restauración al volver,
  salida de campos de texto y trampa de Tab en modal.
- Biblioteca: carátulas y placeholders, estados disponible/instalado/fallo/paquete ausente/pendiente
  Steam, onboarding, filtros y acciones reales de la API.
- Ficha: metadatos de demostración, elevación, problemas de paquete, jugar, comprobar, abrir carpeta,
  navegación a Steam y selección de destino de instalación.
- Instalación: porcentaje/bytes reales, setup indeterminado (ignora un percent falso), eventos
  `install:progress`, cancelación y errores con detalles saneados.
- Imágenes: pestañas, carga de galería, selección, restauración, importación local y placeholder.
- Identidad: ambigüedad sin preselección visual, confirmación de candidato, búsqueda con teclado en
  pantalla/físico y borrado con confirmación.
- Steam: cuentas, cambios pendientes, confirmación de sync, mensaje programado, ruta de backup,
  logs, selección de perfil y estado sin Steam.
- Ajustes: claves enmascaradas, guardado/borrado con la API, proveedor, idioma, carpetas, raíz y
  salida.

No se puede verificar automáticamente en este entorno: el aspecto exacto en una TV real, la
respuesta de un mando físico, la integración con Steam Input, UAC, los diálogos nativos de Windows,
la reproducción real de `bps-media://` fuera de la ejecución manual o el reinicio de Steam. La
ejecución manual sí confirmó el renderizado real de artwork, la navegación con un gamepad XInput
virtual y el ciclo de instalación demo; falta repetir todo con hardware y Big Picture.

## Contratos que faltan o conviene ampliar

- `openPath` solo acepta `'log' | 'install-dir' | 'package'`; no hay propósito `'steam-backup'`.
  La pantalla de Steam muestra la ruta del backup pero no puede abrir su carpeta con la API
  actual. Se ofrece la carpeta de logs, que sí está validada.
- No hay API para abrir la carpeta de backups de Steam directamente ni para leer el contenido de
  un log.
- No hay API específica para conocer la ruta de instalación por defecto antes de `startInstall`.
  El diálogo muestra ahora la carpeta exacta que se creará (`raíz/<id>`); el backend normaliza el id
  al calcularla y el snapshot contiene la ruta definitiva.
- No hay API para desinstalar, borrar una carpeta de paquetes ni cancelar una sincronización de
  Steam.
- `SteamSyncStartResult.result` es `unknown`. La UI no lo interpreta; si se quiere mostrar detalle
  de sync, conviene tiparlo.
- No hay evento de progreso de sincronización de Steam; solo `steam:changed` con `SteamStatus` y
  `getSteamStatus` bajo demanda.
- No hay API para remapear botones ni para saber si Steam Input está interceptando el mando.
- `onboardingCompleted` está en `AppSettings`, pero el flujo de UI no lo escribe: la biblioteca se
  deriva de que haya juegos. Si se quiere onboarding explícito, debe gestionarlo el backend o
  añadirse una acción de UI.
- Los `previewUrl` de artwork deben ser `bps-media:` (o `data:image/`); una URL remota se ignora y
  se muestra el placeholder local. Esto es intencional para no romper la CSP ni depender de red.
