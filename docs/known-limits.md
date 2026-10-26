# Límites conocidos

Estos límites son deliberados y forman parte del MVP; no se presentan como
funciones completas.

## Instalación

- **No hay instalación silenciosa universal.** Los argumentos salen del
  manifiesto y deben haberse verificado con ese instalador. El perfil no inyecta
  opciones.
- **La cancelación durante el setup no es segura** y no se ofrece. Solo se puede
  cancelar la validación y la extracción. Cerrar la app no mata el instalador.
- **No hay rollback completo.** Si el setup falla, el destino puede quedar con
  archivos parciales; la app no borra instalaciones parciales automáticamente.
  Se puede comprobar el estado o elegir una carpeta nueva.
- **No se sobrescribe un destino con archivos.** Para reinstalar en el mismo
  lugar hay que resolverlo manualmente. Esto evita destruir datos sin política.
- **Una sola instalación simultánea**.
- **La detección de procesos secundarios se hace por archivos de verificación**,
  no esperando por nombres genéricos de proceso. Un instalador que escribe fuera
  del destino o no crea los archivos declarados no se puede verificar.
- Los instaladores que requieren interacción de UI pueden abrir sus propias
  ventanas; la app no automatiza clics.
- **Elevación/UAC:** se usa un auxiliar aislado que eleva solo el setup. La app
  nunca se ejecuta completa como administrador. El escritorio seguro de UAC no se
  puede controlar con el mando; se requiere teclado/ratón y una decisión manual.
  El camino del auxiliar sin UAC está probado; el diálogo UAC real no se ha
  automatizado. Si el usuario cancela UAC, la instalación falla con un mensaje
  claro y no se modifica el sistema. Los instaladores que piden elevación por sí
  solos pueden fallar con un error claro.
- Un cierre inesperado deja el estado `interrupted`; no se reanuda un setup a
  ciegas. El PID se conserva en la base y se registra, pero no se termina.
- No se comprueba ni se garantiza espacio en el volumen de destino para lo que
  el instalador necesite más allá del payload; solo se comprueba el espacio de
  extracción y se registra el disponible.

## Paquetes y catálogo

- Las carpetas configuradas se escanean **sin recursión**; usa varias carpetas o
  mueve los `.game` a la raíz de una carpeta configurada. Solo se admiten rutas
  locales con letra de unidad; las rutas UNC/extendidas se rechazan.
- No hay interfaz para **quitar** una carpeta de paquetes ni para desinstalar un
  juego o borrar accesos gestionados de Steam. Se documenta como trabajo futuro.
- El destino del paquete debe ser el mismo ZIP íntegro; si cambia después de
  importarlo, la instalación falla por SHA-256 y pide volver a importar.
- Duplicados del mismo `id@version` con hash distinto se rechazan; no se
  sustituyen automáticamente.
- El mismo juego instalado con una versión anterior no se actualiza desde la UI;
  una versión nueva aparece como disponible, pero la instalación existente se
  conserva. No hay desinstalador.
- Los paquetes movidos se reconocen si el hash coincide y el archivo anterior ya
  no existe; varias copias se tratan como duplicados.
- No se admiten ZIP cifrados, enlaces simbólicos, nombres colisionantes ni
  entradas fuera de `manifest.json` + `payload/`.
- No se valida la firma Authenticode ni se ejecuta antivirus.

## Interfaz

- La app está pensada para 16:9 y pantalla completa. La navegación se ha
  validado con un mando XInput virtual (ViGEmBus) además de eventos sintéticos;
  falta la prueba con un mando físico y desde Steam Big Picture.
- Los mandos deben exponerse con `mapping: standard`. Se ignoran vJoy/joysticks
  genéricos (incluso si declaran mapping estándar) para no interpretar botones
  con otro orden; un volante o mando exótico puede no ser compatible.
- Se muestra un aviso nativo de Windows si se intenta cerrar la app durante una
  instalación. Ese diálogo puede requerir teclado/ratón; el mando no controla el
  escritorio seguro ni los diálogos del sistema.
- Texto libre (búsqueda de identidad y clave de API) puede requerir teclado; las
  búsquedas tienen teclado en pantalla cuando está disponible.
- UAC y diálogos de seguridad de Windows no se pueden manejar desde la UI.
- El cierre/reinicio de Steam lo controla Steam; si tarda en cerrar, la sync se
  aborta y se conserva el estado para reintentar.
- La app no modifica la ficha de Steam Store ni usa AppIDs comerciales ajenos.
  Los accesos externos no admiten todos los campos de una tienda.

## Steam

- `shortcuts.vdf` es un formato binario no documentado oficialmente; se prueba
  contra fixtures y bibliotecas de referencia, no contra una instalación real en
  esta sesión.
- Solo se sincronizan entradas gestionadas por la app; las entradas ajenas se
  preservan. Hay referencias separadas por cuenta, pero no un flujo de retirada
  o reconciliación de accesos antiguos.
- Una sincronización interrumpida se detecta por la antigüedad del estado del
  auxiliar y se marca como fallida para permitir reintentar; si el auxiliar
  continúa vivo pero no escribe estado, puede tardar unos minutos en liberarse.
- El artwork se aplica con los nombres de archivo compatibles investigados. Steam
  puede cambiar el comportamiento entre versiones; no hay API pública para
  editar toda la biblioteca en caliente.
- Las capturas y descripciones no forman parte de la ficha externa; se conservan
  en el catálogo propio.
- La sincronización requiere cerrar Steam. Si la app se lanzó desde Steam, el
  auxiliar se lanza desacoplado y escribe un resultado para el siguiente
  arranque. Esto debe validarse en una instalación real.
- Añadir BPSteamFit como juego externo de Steam se hace una vez, manualmente
  desde Big Picture/escritorio; ver README. No hay auto-inserción de la propia app.

## Metadatos y artwork

- El proveedor por defecto es `mock`, offline. No se presenta contenido mock como
  oficial.
- SteamGridDB es opcional y requiere una clave del usuario guardada con DPAPI.
  Sin clave no se consulta. No se ha validado una llamada real en esta sesión.
- No se implementa IGDB/RAWG en el MVP; SteamGridDB no aporta descripciones,
  desarrolladores o géneros. No se inventan campos.
- Los datos vienen mayoritariamente en inglés; se conserva el idioma y no se
  generan traducciones automáticas.
- No se usa IA para sustituir artwork. Los placeholders son locales y propios.
- No hay scraping silencioso ni fallback a páginas no autorizadas.

## Distribución

- El instalador no está firmado; SmartScreen puede mostrar advertencia.
- El runtime Electron ocupa más que una app nativa. Es una decisión consciente.
- No se incluyen claves, secretos ni juegos comerciales.
- Los tests de empaquetado se ejecutan en Windows; no se afirma compatibilidad
  con otras plataformas.
