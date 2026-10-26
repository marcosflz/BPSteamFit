# Criterios de aceptación — estado real

Fecha: 2026-10-26. La columna «evidencia» distingue lo probado automáticamente de
lo observado manualmente en esta máquina y de lo que sigue pendiente.

| # | Criterio | Estado | Evidencia / límite |
|---|---|---|---|
| 1 | Generar e importar el demo `.game` | **Cumplido** | `npm run demo` genera `demo/out/ExampleQuest.game`; CLI `validate`/`create`; integración de catálogo y UI. |
| 2 | Biblioteca navegable con mando | **Cumplido con mando XInput virtual; mando físico/Steam Input pendiente** | Motor gamepad con deadzone/repeat y tests; foco visible y diálogos. En esta sesión se creó un mando Xbox XInput virtual con ViGEmBus y se navegó de verdad: conexión, cruceta, A para abrir ficha, B para volver y Start para Ajustes. Se corrigió un bug real de selección con dispositivos vJoy. Falta la prueba con hardware físico y Steam Input real. |
| 3 | Metadatos automáticos con proveedores configurados | **Cumplido en mock; real no probado en red** | Importación del demo resolvió identidad mock, descripción y artwork; proveedor SGDB implementado y testeado con respuestas simuladas, sin clave real. |
| 4 | Resolución de ambigüedad sin asociación silenciosa | **Cumplido** | `tests/catalog/enrichment.test.ts` fuerza una búsqueda ambigua, comprueba que no selecciona ni descarga metadatos y que el usuario puede elegir después. Tests de matching para secuelas/remake/edición. |
| 5 | Placeholders y funcionamiento sin Internet | **Cumplido** | El modo por defecto es mock offline; arte propio; UI muestra placeholders; fallos de proveedor/caché no bloquean catálogo ni instalación. |
| 6 | Extraer y ejecutar el setup demo | **Cumplido** | Motor real y setup WinForms propio; test de motor e integración vertical; ejecución manual desde la UI empaquetada. |
| 7 | Verificar el resultado | **Cumplido** | Verificación de archivos/directorios, espera a procesos secundarios y tamaño estable; tests de éxito/fallo/reinicio/proceso secundario. |
| 8 | Conservar estados y errores | **Cumplido** | SQLite, snapshots, eventos, `interrupted` al arrancar, logs; tests de recuperación e integración. |
| 9 | Preparar acceso externo y assets | **Cumplido contra fixtures** | `SteamService` construye shortcuts y artwork; test de integración con `shortcuts.vdf` real en temp, icono `.ico` e ids estables. No se escribió el Steam real. |
| 10 | Aplicar cambios con sincronización segura | **Implementado y probado con deps simuladas** | Orquestador core con cierre normal/espera/aborto, backup, escritura atómica y reapertura; 67 tests Steam. El cierre/reapertura de una instalación Steam real no se ha ejecutado. |
| 11 | No duplicar accesos ni alterar ajenos | **Cumplido contra fixtures** | Tests de idempotencia, preservación de entradas ajenas, colisiones y conflicto en el servicio (no se adopta el acceso ajeno). |
| 12 | Pruebas y documentación reproducible | **Cumplido con limitaciones documentadas** | 42 archivos / 291 pruebas offline, demo reproducible, README, esquema, arquitectura, seguridad, límites, aceptación, Steam, proveedores y UI. |

## Verificación manual realizada

- App de desarrollo y app empaquetada arrancadas en Windows 11.
- Escaneo de `demo/out/ExampleQuest.game` desde la carpeta configurada.
- Biblioteca, ficha, diálogo de destino, instalación real del demo, progreso,
  verificación, resultado y log.
- Lanzamiento del juego demo desde la ficha.
- Pantalla de identidad y galería de artwork con datos mock.
- Detección de la instalación real de Steam y de la cuenta real sin modificar
  `shortcuts.vdf` ni datos de Steam.
- `BPSteamFit.exe` empaquetado y worker `sync-worker.js` ejecutado desde
  `app.asar` con `ELECTRON_RUN_AS_NODE=1` (sin trabajo real de Steam).
- Instalador NSIS generado correctamente.
- Mandos XInput virtuales con ViGEmBus: navegación por cruceta/stick, A/B/Start
  y selección correcta del gamepad estándar frente a vJoy.
- Diálogo de instalación mostrando la carpeta exacta que se creará.

## Pendiente de verificación manual explícita

- Repetición final con mando físico y Steam Input/Big Picture real. La
  navegación con un mando XInput virtual ya se verificó manualmente.
- Ciclo real de sincronización Steam: cierre, backup, escritura, reapertura en
  Big Picture. No se ha ejecutado por seguridad sobre la instalación real.
- UAC real del auxiliar de elevación.
- SteamGridDB con clave real.
- Instalación del NSIS en una máquina limpia y arranque desde Steam Big Picture.
