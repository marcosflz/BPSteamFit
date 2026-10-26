# Arquitectura

## Decisión de stack

Se compararon tres opciones razonables para Windows, pantalla completa, mando,
procesos, SQLite, imágenes y distribución:

| Opción | Ventajas | Costes/riesgos en este entorno |
| --- | --- | --- |
| .NET 8 + Avalonia/WPF | Nativo, maduro, excelente integración Windows | No hay SDK de .NET instalado; UI de salón y Gamepad requieren trabajo adicional y la iteración visual es más lenta |
| Tauri 2 + Rust + WebView2 | Binario pequeño, backend fuerte, UI web | Compilación inicial lenta; Gamepad API/WebView2 y toolchain añaden incertidumbre para verificar el flujo completo en esta sesión |
| **Electron 45 + TypeScript + React** | Chromium fiable para fullscreen y Gamepad API, Node para procesos/ZIP/SQLite, pruebas rápidas | Runtime grande (~100 MB); hay que cuidar seguridad de renderer y empaquetado de nativos |

**Elegido: Electron 45 + TypeScript + React + SQLite (`node:sqlite`) + `sharp` + `yauzl`/`yazl`.**

Motivos concretos:

- Node 24, npm y Electron están disponibles y permiten verificar el flujo real.
- Un único proceso principal gestiona archivos, procesos y SQLite; el renderer
  solo pinta y navega. **No hay servidor HTTP.**
- Chromium ofrece Gamepad API y fullscreen consistentes en Windows; se usa una
  sola fuente de entrada para evitar duplicados.
- `node:sqlite` viene incluido en el Node de Electron 45 y evita módulos nativos
  adicionales. `sharp` se usa para validar y procesar imágenes.
- El paquete se distribuye con `electron-builder` (NSIS, por usuario).

Consecuencias aceptadas: huella de disco mayor que una app nativa, necesidad de
empaquetar `sharp` fuera de ASAR y una superficie de seguridad de renderer que
se mitiga con `contextIsolation`, sin `nodeIntegration`, CSP, preload mínimo,
navegación bloqueada y validación en el proceso principal.

## Vista general

```
┌───────────────────────────── Electron ─────────────────────────────┐
│ Renderer React (sandbox de UI, sin Node)                           │
│  · Biblioteca / ficha / progreso / identidad / artwork / Steam     │
│  · Entrada de mando y teclado                                      │
│  · Solo habla con window.bps (contextBridge)                       │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ IPC tipado (invoke/event)
┌───────────────────────────────▼─────────────────────────────────────┐
│ Proceso principal                                                   │
│  CatalogService   InstallService   MetadataService   SteamService   │
│  Package/ZIP      InstallEngine    ArtworkService    SyncWorker     │
│  Settings         Logs/redacción   Cache             Backups        │
│                                                                     │
│  SQLite local (catálogo, instalaciones, caché, mappings, syncs)     │
│  Windows: procesos, archivos, DPAPI (safeStorage), protocolo media  │
└─────────────────────────────────────────────────────────────────────┘
```

## Módulos y responsabilidades

- `src/shared/`: contratos de dominio, IPC, manifiesto Zod, errores tipados,
  validación de rutas.
- `src/core/package/`: lectura ZIP con límites, validación del paquete,
  extracción segura, creación de `.game`.
- `src/core/install/`: perfiles informativos, motor de setup, verificación,
  servicio de instalación/revalidación/lanzamiento.
- `src/core/catalog/`: escaneo de carpetas, detección de duplicados/versiones/
  movimientos, mapeo de la biblioteca.
- `src/core/storage/`: migraciones SQLite y repositorios.
- `src/core/metadata/` y `src/core/artwork/`: proveedores, resolución de
  identidad, caché, descarga y variantes de imagen.
- `src/core/steam/`: VDF binario, shortcuts, artwork, backups y orquestador del
  auxiliar de sincronización.
- `src/main/`: composición de servicios, ventana, IPC, secretos, protocolo de
  medios y ciclo de vida.
- `src/preload/`: API mínima `window.bps`; no expone Node.
- `src/renderer/`: experiencia de salón y entrada de mando.
- `src/cli/`: validar/crear/inspeccionar paquetes.

## Flujo de datos principal

1. `CatalogService` escanea carpetas configuradas. Los archivos deben estar
   estables; se inspecciona el ZIP sin extraerlo.
2. Se valida el manifiesto y se registra por `id@version`; la UI recibe el
   catálogo con placeholders inmediatamente.
3. Los metadatos/artwork se resuelven en segundo plano y se cachean. Un fallo de
   red nunca bloquea la instalación.
4. `InstallService` confirma destino, revalida el hash, extrae a un temporal
   exclusivo, ejecuta el setup **sin shell**, espera su salida, verifica archivos
   (incluidos los que escribe un proceso secundario) y persiste cada transición.
5. Al instalar, el juego queda `steam_sync_pending`. `SteamService` construye el
   acceso externo y el artwork y pide confirmación para cerrar/reabrir Steam.
6. Un auxiliar independiente aplica los cambios con Steam cerrado, hace backup
   atómico y escribe un resultado. La app lo lee en el siguiente arranque.

## Persistencia

SQLite en `%APPDATA%/BPSteamFit/bpsteamfit.sqlite3` (ruta de `app.getPath('userData')`).
Tablas separadas por dominio: `games`, `packages`, `installs`, `install_events`,
`metadata_cache`, `artwork`, `steam_shortcuts`, `steam_syncs`, `settings`,
`secrets`. Los JSON se guardan en columnas independientes para no mezclar datos
del paquete, instalación, metadatos y preferencias.

Los logs van a `%APPDATA%/BPSteamFit/logs/`. Los temporales de extracción van a
`%APPDATA%/BPSteamFit/temp/bpsfit-install-*` y se eliminan al terminar, salvo
diagnóstico explícito por variable de entorno.

## Decisiones y límites deliberados

- Una sola instalación simultánea en el MVP.
- El destino debe ser nuevo o estar vacío; no se sobrescribe una instalación.
- No se añaden argumentos silenciosos automáticamente. El perfil es informativo;
  los argumentos verificados viven en el manifiesto.
- No se mata el setup al cancelar. Solo se cancela validación/extracción.
- No se reinicia Windows automáticamente; `reboot_pending` es un estado visible.
- La elevación usa un auxiliar aislado que eleva **solo el setup** mediante
  `ShellExecuteEx(runas)`. La app no se ejecuta como administrador. UAC pertenece
  al escritorio seguro y se controla manualmente; el mando no puede interactuar
  con él. Ver `docs/known-limits.md`.
- Sin cloud, sin servicio Windows, sin servidor local.
- El modo por defecto de metadatos es `mock`; los proveedores reales son
  opcionales y requieren clave del usuario.
- Las escrituras de Steam se prueban contra fixtures. No se modifica un Steam real
  sin consentimiento explícito.

## Errores y estados

Los errores internos son `AppError` con `code`, mensaje para usuario y detalles
técnicos. La UI nunca recibe stack ni secretos. Las instalaciones tienen estados
persistidos: `available`, `validating`, `extracting`, `installing`, `verifying`,
`installed`, `reboot_pending`, `failed`, `cancelled`, `interrupted`. Al arrancar,
cualquier estado transitorio se convierte en `interrupted` y queda un evento.
