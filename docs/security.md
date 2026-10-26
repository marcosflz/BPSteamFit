# Seguridad

## Modelo de amenazas

Se consideran no confiables:

- El paquete `.game`, su manifiesto, sus rutas y su ZIP.
- El `setup.exe` y cualquier proceso que lance.
- Las imágenes descargadas de proveedores.
- Los archivos `shortcuts.vdf` y artwork de Steam (pueden haber sido editados
  por otros programas).
- La entrada del renderer (aunque sea local, se trata como no confiable).

La app no descarga juegos, no implementa evasión de DRM, no desactiva antivirus y
no eleva todo el proceso. La validación del ZIP no concede confianza al setup: la
ejecución siempre requiere confirmación.

## Defensas implementadas

### Paquetes y extracción

- Solo ZIP con `manifest.json` raíz y `payload/**`.
- Rechazo de rutas absolutas, UNC, unidades, dispositivos, `..`, separadores
  invertidos, nombres reservados de Windows, trailing dots/spaces y controles
  bidireccionales.
- Rechazo de enlaces simbólicos, entradas cifradas, métodos de compresión no
  admitidos y colisiones case-insensitive.
- Límites de número de entradas, tamaño por entrada, tamaño total y ratio de
  compresión (posible ZIP bomb).
- Validación de tamaño durante la extracción, escritura exclusiva (`wx`),
  comprobación de contención con rutas canónicas y comprobación del tamaño final.
- El destino de instalación debe ser una ruta absoluta, nueva o vacía, fuera de
  Windows, del directorio temporal y de las carpetas gestionadas por la app.
- La UI no ejecuta nada al copiar o importar un paquete.
- El motor revalida el SHA-256 del paquete antes de extraer y ejecutar.
- El setup se lanza con `spawn` y `shell: false`; los argumentos se pasan como
  vector, no como línea de comandos interpretada por un shell.

### Instalación

- Confirmación explícita antes de ejecutar código.
- Una sola instalación simultánea.
- Persistencia de cada transición y detección de interrupciones al arrancar.
- Durante el setup no se fuerza la terminación. La cancelación solo se permite en
  validación/extracción; el setup se deja terminar.
- No se reinicia Windows automáticamente. Un código de reinicio se distingue de
  un fallo (`reboot_pending`).
- Logs limitados en tamaño y con redacción de patrones de credenciales.
- Temporales con prefijo propio y borrado restringido a la carpeta gestionada.

### Red y secretos

- Sin servidor HTTP ni API cloud propia.
- Los proveedores reales usan HTTPS, timeouts, tamaño máximo, validación de
  respuesta y orígenes permitidos. No hay scraping.
- Las claves de proveedor se aporta el usuario; no se incluyen en el ejecutable
  ni en el repositorio.
- En Windows se guardan cifradas con Electron `safeStorage` (DPAPI). La UI solo
  muestra si están configuradas; nunca devuelve el valor.
- Los logs no reciben la clave. Los errores de red no incluyen cabeceras.
- La app funciona sin Internet, sin clave y sin artwork.

### Steam

- Adaptador aislado y probado contra fixtures; no se toca el Steam real en tests.
- Antes de escribir se crea un backup con timestamp.
- Escritura atómica en el mismo volumen y validación posterior; si falla, se
  intenta restaurar.
- Solo se modifican accesos gestionados por la app. Las entradas ajenas se
  preservan; una colisión se reporta y no se adopta silenciosamente.
- Steam debe cerrarse de forma normal; si no cierra, se aborta sin matar procesos.
- Los cambios pendientes se guardan en SQLite antes de lanzar el auxiliar. Si el
  auxiliar falla, el estado y el backup quedan para reintentar.
- No se promete una ficha de tienda ni campos que los accesos externos no
  soportan. Descripción y metadatos ricos se conservan en el catálogo propio.

## Límites de seguridad (importantes)

- **Un `setup.exe` puede hacer cualquier cosa que permita el usuario que lo
  ejecuta**, incluido escribir fuera del destino. La app no es un sandbox.
- No se verifica la firma Authenticode del setup ni se escanea con antivirus.
  Los checksums detectan cambios, no confianza.
- No hay rollback completo de instalaciones; el MVP se niega a sobrescribir un
  destino no vacío y no borra instalaciones parciales automáticamente.
- La elevación de un setup usa un auxiliar propio y aislado que llama a
  `ShellExecuteEx` con el verbo `runas`, únicamente para ejecutar el instalador
  declarado. La app nunca se ejecuta completa como administrador. UAC pertenece
  al escritorio seguro y no puede controlarse desde la interfaz con mando; la
  intervención manual es necesaria. El camino sin UAC del auxiliar está probado;
  la interacción real con UAC no se ha automatizado.
- El auxiliar de elevación recibe únicamente una ruta de setup, argumentos ya
  validados y un directorio de trabajo; no acepta scripts ni comandos de shell.
  Los argumentos se serializan con el algoritmo de `CommandLineToArgvW`.
- Los secretos dependen de DPAPI y de la sesión Windows del usuario.
- Una misma cuenta de usuario puede modificar los archivos locales de la app. La
  seguridad frente a un atacante con la misma cuenta está fuera de alcance.
- La confirmación de instalación y de sincronización es una **decisión de la
  interfaz**, no una autenticación del sistema operativo. Un renderer
  completamente comprometido podría invocar los canales IPC permitidos. La CSP,
  `contextIsolation`, la ausencia de contenido remoto y el preload mínimo reducen
  la superficie, pero no convierten el renderer en una frontera de confianza
  fuerte. Para un modelo con renderer hostil habría que añadir un diálogo nativo
  o una autorización externa; eso chocaría con el uso diario con mando y no está
  implementado en el MVP.
- Las rutas de instalación/pak son locales con letra de unidad; se rechazan
  prefijos extendidos, UNC y dispositivos. No se resuelven todas las posibles
  junctions o aliases 8.3 creados por otro proceso con la misma cuenta.
- El renderer tiene CSP, `contextIsolation`, `nodeIntegration: false`, navegación
  restringida al índice local y no puede abrir ventanas. Aun así, Electron no es
  un sandbox para código nativo malicioso ejecutado por el usuario.
- Los tests de Steam usan fixtures; la escritura sobre una instalación real de
  Steam requiere consentimiento y no se ha ejecutado en esta sesión.
