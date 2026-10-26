# Proveedores de metadatos

Documento de decisiones e integración del área de metadatos. Fecha de
investigación y verificación: **2026-10-26**.

## Decisión

La aplicación usa **mock por defecto** y **SteamGridDB v2 como proveedor real
opcional**. No se implementa IGDB ni RAWG en esta entrega porque:

- SGDB cubre lo que el producto necesita para la biblioteca: identidad por
  nombre, arte vertical/horizontal/logos/iconos.
- IGDB exige un segundo flujo OAuth contra Twitch (Client ID + Client Secret,
  token y refresco) además del identificador del juego; su valor principal son
  descripciones y compañías, que no son imprescindibles para instalar.
- RAWG exige la clave en la query string, lo que complica la redacción de logs
  y la política de secretos, y su plan gratuito impone atribución con enlace
  activo y 20.000 peticiones al mes.
- El mínimo implementable y verificable sin clave es SGDB + mock. La limitación
  de SGDB (no da descripciones ni compañías) se conserva y se documenta; no se
  rellena con datos inventados.

| Proveedor | Identidad | Descripciones | Compañías | Arte | Clave | Estado |
|---|---|---|---|---|---|---|
| `mock` | Sí, fixtures | Sí, ficticias es/en | Sí, ficticias | 5 tipos, arte propio | No | Implementado y probado |
| `steamgriddb` | Sí | **No** | **No** | portrait/hero/logo/icon | Bearer | Implementado; sin prueba real por falta de clave |
| IGDB | Sí | Sí | Sí | cover/artwork/screenshot | OAuth Twitch | Evaluado, no implementado |
| RAWG | Sí | Sí | Desarrolladores/editoras | screenshots/background | API key en query | Evaluado, no implementado |

## SteamGridDB API v2

### Base y versión

- Base URL: `https://www.steamgriddb.com/api/v2`.
- La especificación OpenAPI publicada el 2026-10-26 declara `info.version:
  2.10.0`.
- Documentación: <https://www.steamgriddb.com/api/v2>
- OpenAPI: <https://www.steamgriddb.com/static/openapi.yml>

### Autenticación

La especificación define `securitySchemes.API Key` de tipo `http` con esquema
`bearer`:

```http
Authorization: Bearer <token>
```

La clave se genera en <https://www.steamgriddb.com/profile/preferences>.

Implementación:

- La clave se recibe por parámetro, nunca se escribe en el código.
- Solo se envía en la cabecera `Authorization`; no se añade a la URL.
- No se incluye en mensajes de error, `details` ni logs.
- Un `401`/`403` se traduce a `METADATA_AUTH_REQUIRED`.
- Sin clave, el proveedor se construye pero `isConfigured()` es `false` y el
  mock sigue funcionando.

### Endpoints usados

| Uso | Endpoint | Parámetros relevantes |
|---|---|---|
| Buscar identidad | `GET /search/autocomplete/{term}` | `term` codificado en la ruta |
| Detalle | `GET /games/id/{gameId}` | `platformdata` opcional, no usado |
| Portadas | `GET /grids/game/{gameId}` | `dimensions`, `types`, `mimes`, `styles`, `nsfw`, `humor`, `epilepsy`, `limit`, `page` |
| Heroes | `GET /heroes/game/{gameId}` | igual, con dimensiones de hero |
| Logos | `GET /logos/game/{gameId}` | `types`, `mimes`, `styles`, filtros |
| Iconos | `GET /icons/game/{gameId}` | `types`, `mimes`, `styles`, filtros |
| Capturas | **No existe endpoint** | No se inventa |

La petición de portrait usa dimensiones `600x900,342x482,660x930`; hero usa
`1920x620,3840x1240,1600x650`. Los iconos se piden solo como `image/png`
porque sharp no decodifica ICO de forma fiable; SGDB también admite
`image/vnd.microsoft.icon`, que se descarta. Logo admite PNG/WebP.

### Filtros y límites documentados

Según la especificación OpenAPI:

- `limit`: por defecto `50`; **los valores mayores que 50 se ignoran**. El
  cliente limita a `1..50`.
- `page`: por defecto `0`.
- `types`: `static` o `animated`; usamos `static`.
- `nsfw`, `humor`, `epilepsy`: `false` (excluir), `true` (solo ese contenido)
  o `any` (incluir ambos). Usamos siempre `false` por defecto.
- `oneoftag`: filtra por cualquiera de `humor,nsfw,epilepsy`.
- `styles` por tipo:
  - grids: `alternate,blurred,white_logo,material,no_logo`
  - heroes: `alternate,blurred,material`
  - logos: `official,white,black,custom`
  - iconos: `official,custom`
- `dimensions` de grid: `460x215,920x430,600x900,342x482,660x930,512x512,1024x1024`.
- `dimensions` de hero: `1920x620,3840x1240,1600x650`.
- MIME de grid/hero: PNG/JPEG/WebP; logo: PNG/WebP; icono: PNG/ICO.

### Campos reales y limitaciones

La especificación OpenAPI documenta para `Game` solo `id`, `name`, `types` y
`verified`. El cliente oficial de TypeScript añade `release_date` y, para
imágenes, campos como `width`, `height`, `mime`, `language`, `type`, `notes`,
`upvotes` y `downvotes`:

- <https://github.com/SteamGridDB/node-steamgriddb>

Nuestra validación con Zod trata esos campos como **opcionales** y no los
inventa. Solo se usan `id`, `url`, `thumb`, `width`, `height`, `mime`, `style`,
`language`, `tags` y `author` cuando están presentes. Si faltan dimensiones, el
candidato no se auto-selecciona, porque no se puede verificar la relación de
aspecto.

Limitaciones que se conservan:

- **No hay descripciones, argumento, desarrolladores, editoriales, géneros,
  modos de juego ni capturas** en la API v2 usada.
- `GameMetadata` de SGDB sale con `title`, `provider`, `providerId`,
  `fetchedAt`, `isMock: false` y, si el campo opcional existe, `releaseYear` /
  `releaseDate`. El resto queda sin definir.
- No se completa información con datos de otro proveedor ni con texto
  generado.
- `release_date` no está documentado en el OpenAPI oficial; su presencia y
  formato (segundos Unix) proceden del cliente oficial y **no se ha verificado
  contra la API real con clave**. Si no está, la identidad se resuelve por
  título y el año queda ausente.
- No hay endpoint de screenshots. `listArtwork(id, 'screenshot')` devuelve `[]`
  sin hacer red.

### CDN y descargas

Hosts de imagen permitidos, verificados con peticiones `HEAD` el 2026-10-26:

- `https://cdn.steamgriddb.com`
- `https://cdn2.steamgriddb.com`

Ejemplo verificado: la página pública <https://www.steamgriddb.com/grid/846997>
declara `og:image` en `https://cdn2.steamgriddb.com/thumb/...`, y tanto
`cdn.steamgriddb.com` como `cdn2.steamgriddb.com` respondieron `200` con
`image/jpeg`/`image/png` para sus rutas de thumbnail/grid. `cdn3` no resolvió.
La extensión y ruta exactas dependen del asset, por lo que **no se construyen
URLs**: solo se aceptan URLs devueltas por la API que pasen la lista blanca.

Reglas de descarga:

- Solo HTTPS, sin credenciales embebidas, puerto 443/vacío.
- Redirecciones manuales, máximo 3, revalidadas en cada salto; una redirección
  a otro host se rechaza.
- Timeout, tamaño máximo y validación real con sharp (ver `docs/artwork.md`).
- No se hace scraping ni se solicitan páginas HTML de SGDB.

### Límites de uso

La especificación OpenAPI consultada **no publica un límite de peticiones por
minuto/hora**. No se ha encontrado una cifra oficial en la documentación de la
API. Por tanto:

- No se inventa un número de rate limit.
- El cliente hace el mínimo de peticiones: una búsqueda, un detalle y, como
  mucho, una lista por tipo de artwork.
- Timeout de 8 s por petición; 2 reintentos máximos; backoff exponencial
  (300 ms, 600 ms) solo para error de red, `408`, `425`, `429` y `5xx`.
- En `429` se respeta `Retry-After` en segundos o fecha HTTP. Si supera 30 s,
  no se reintenta y se devuelve `METADATA_RATE_LIMITED`.
- `401`/`403`, `4xx` no transitorios, respuestas inválidas, SVG y tamaños
  excesivos no se reintentan.
- El servicio cachea para no repetir consultas en cada apertura (ver abajo).

Los Términos de Servicio prohíben la carga desproporcionada y el uso
automatizado de scraping; nuestro uso es la API oficial con una clave de
usuario, sin scraping.

### Licencias, atribución y caché

Términos de Servicio de SteamGridDB (efectivos 2019-07-31):
<https://www.steamgriddb.com/terms>

Puntos relevantes:

- Se permite el acceso para **uso personal y no comercial** según la
  funcionalidad normal del servicio.
- No se permite distribuir partes del servicio sin permiso escrito explícito.
- El contenido de usuario conserva la propiedad de su autor y se concede una
  licencia a SGDB y a sus usuarios para acceder y usar el contenido a través
  del servicio.
- SGDB no garantiza que el contenido de usuario no infrinja derechos de
  terceros; su DMCA está disponible.
- La API no devuelve un campo de licencia por imagen. Por eso `license` queda
  sin definir y no se afirma que un asset sea reutilizable.

Consecuencias para la aplicación:

- El arte se muestra con atribución visible al autor cuando la API lo aporta
  (`attribution`), sin declarar una licencia inexistente.
- La caché local es **por usuario**, para su biblioteca personal; no se
  empaqueta arte de SGDB en instaladores, repositorios ni actualizaciones.
- No se ofrece redistribución ni venta de imágenes.
- El uso comercial requeriría permiso escrito de SGDB; el producto debe
  tratarse como uso personal mientras no exista ese acuerdo.
- No hay TTL de caché publicado por SGDB. Los TTL son una decisión conservadora
  del cliente, no una obligación del proveedor:
  - búsqueda: 24 h
  - detalle: 7 días
  - listas de artwork: 12 h
  - al expirar, si falla la red o el modo offline está activo, se puede usar el
    registro obsoleto como respaldo, avisando en `warning`.
- Los fixtures del proveedor mock y el arte de `fixtures/artwork` son propios y
  no están sujetos a esta licencia.

### Idiomas

SGDB no ofrece metadatos localizados en estos endpoints. Los nombres de juego
los devuelve tal como están en su base; las etiquetas de idioma de una imagen
(`language`), si existen, se conservan. El proveedor mock sí ofrece español e
inglés y marca `GameMetadata.language` con `es`/`en`.

## IGDB y RAWG (evaluación)

### IGDB

Fuente: <https://api-docs.igdb.com/> (consultada 2026-10-26).

- Autenticación OAuth2 contra Twitch: `POST https://id.twitch.tv/oauth2/token`
  con `client_id`, `client_secret` y `grant_type=client_credentials`; después
  `Client-ID` + `Authorization: Bearer` en las peticiones a
  `https://api.igdb.com/v4`.
- Límite documentado: **4 peticiones por segundo** y hasta 8 peticiones abiertas;
  por encima se devuelve `429`.
- Es gratis para uso **no comercial** bajo el Twitch Developer Services
  Agreement; el uso comercial requiere el programa de partners de IGDB.
- Ofrece descripciones, compañías, géneros, fechas, capturas y arte; las
  imágenes usan `images.igdb.com`.
- No se implementa por el coste de integración (dos credenciales y refresco de
  token) y porque el producto no necesita descripciones para instalar.

### RAWG

Fuentes: <https://rawg.io/apidocs> y <https://api.rawg.io/docs/> (consultadas
2026-10-26).

- Clave en la query string (`?key=...`), lo que aumenta el riesgo de que acabe
  en logs, historiales o mensajes de error.
- Plan gratuito: proyectos personales y de hobby, **no comercial**, hasta
  **20.000 peticiones al mes**, con atribución visible y un enlace activo a
  RAWG desde las páginas donde se usan los datos.
- El plan Business es de 149 USD/mes (50.000 peticiones); Enterprise tiene
  hasta 1.000.000. Los términos prohíben la redistribución de datos.
- Ofrece descripciones, desarrolladores, editoriales, capturas y enlaces a
  tiendas.
- No se implementa por la clave en URL, las condiciones de atribución y no
  necesitar descripciones en esta fase.

## Contrato de proveedores

La fábrica `createMetadataProvider` devuelve mock por defecto. Cada proveedor
declara `info` (id, nombre, capacidades, `requiresKey`, descripción y
atribución), `isConfigured()` y se puede consultar su estado con
`providerRuntimeState(provider, { offline })` / `providerStatus(...)`.

## Resolución de identidad

Implementada en `src/core/metadata/normalization.ts`,
`matching.ts` e `identity-service.ts`:

- Normaliza Unicode/acentos para comparar, sin reescribir el título mostrado.
- Conserva números de secuela (arábigos y romanos), subtítulos y tokens como
  `remake`/`remaster`; las ediciones (`deluxe`, `definitive`, `goty`, etc.) se
  detectan aparte para puntuarlas.
- Puntuación heurística 0..100 (título, año, edición, variante, secuela y
  plataforma si existe). No es una probabilidad.
- Auto-selección solo si:
  - el título normalizado completo coincide exactamente;
  - edición, variante (remake/remaster), número de secuela y plataforma son
    compatibles;
  - el año está a ±1 cuando la consulta lo aporta; si la consulta no lo aporta,
    el título exacto debe ser único;
  - la puntuación es ≥ 82 y la ventaja sobre el segundo es ≥ 15 puntos.
- En cualquier otro caso se devuelve `status: 'ambiguous'` con candidatos.
- `providerIds` del manifiesto tienen prioridad: si existe el ID del proveedor
  activo, se devuelve `confirmed`/`decidedBy: 'manifest'` sin buscar. Si el
  manifiesto solo fija IDs de otro proveedor, no se mezclan resultados.
- `confirmIdentity`, `correctIdentity` y `continueWithoutMetadata` representan
  las decisiones del usuario como `IdentityState`; el coordinador las persiste.
- Un fallo del proveedor o el modo offline no lanza desde la resolución: se
  devuelve `state: 'none'` con `error` serializado y, si hay caché, los datos
  disponibles con aviso.

## Configuración sin secretos

El coordinador debe guardar la clave en `safeStorage`/almacén del sistema y
pasar solo el valor al crear el proveedor:

```ts
const provider = createMetadataProvider({
  provider: settings.metadataProvider, // 'mock' | 'steamgriddb'
  apiKey: await secretStore.get('steamgriddb'), // nunca en settings.json
  language: settings.referToMetadataInSpanish ? 'es' : 'en'
})
```

Reglas:

- No commitear claves, `.env` ni fixtures con claves.
- No incluir la clave en URLs, mensajes, `SerializedAppError`, telemetría ni
  logs.
- Los tests usan una clave ficticia (`sgdb-test-key-not-real`) y un servidor
  local; nunca una clave real.
- Si no hay clave, la UI debe mantener el mock y mostrar `configured: false`.

## Implementado frente a verificado

Implementado y probado offline:

- Contrato `MetadataProvider` con `searchCandidates`, `getGame`, `listArtwork`,
  info/capacidades/estado.
- Mock con cuatro fixtures (base 2026, secuela 2028, remake 2024 y Deluxe
  Edition 2026), metadatos es/en y arte original de cinco tipos.
- SGDB v2 con Bearer, búsqueda, detalle, grid/hero/logo/icon, filtros seguros,
  timeout, AbortSignal, reintentos/backoff, `Retry-After`, límite de respuesta,
  validación Zod y errores tipados.
- Resolución de identidad con normalización, puntuación heurística, regla de
  auto-selección, ambigüedad, IDs fijados por manifiesto y decisiones de
  usuario.
- Caché inyectable, TTL, offline, respaldo obsoleto y tolerancia a fallos de
  caché/proveedor.
- Allowlist de CDN, descarga controlada, variantes, selección por aspecto,
  preferencia manual, galería y placeholder.

Verificado:

- OpenAPI 2.10.0, rutas, parámetros, límite de `limit=50`, códigos de error y
  esquema Bearer.
- Términos de servicio (uso personal no comercial, no distribución).
- Hosts de CDN con `HEAD` y página pública de ejemplo.
- Límites de IGDB (4 req/s) y RAWG (20.000/mes, atribución, no redistribución).
- Tests offline de todo el flujo; el servidor local de fixtures se cierra.

No verificado / bloqueos:

- **No se ha hecho ninguna petición real a SGDB** porque no hay clave. No se
  puede confirmar en vivo la presencia de `release_date`, `width`, `height`,
  `mime`, `language`, `type` ni el comportamiento exacto de `429`.
- No se ha verificado si SGDB devuelve `Retry-After` en la práctica; el código
  lo soporta si existe.
- No hay rate limit oficial publicado; el backoff es una política del cliente.
- No hay licencia por asset en la API; la atribución al autor es la mejor
  información disponible, no una autorización de reutilización.
- La compatibilidad de logos con transparencia depende del asset; se conserva
  el alfa si existe y no se inventa.

## Fuentes

Consultadas el 2026-10-26:

- SteamGridDB API v2: <https://www.steamgriddb.com/api/v2>
- SteamGridDB OpenAPI 2.10.0: <https://www.steamgriddb.com/static/openapi.yml>
- Preferencias/clave API: <https://www.steamgriddb.com/profile/preferences>
- Términos de servicio: <https://www.steamgriddb.com/terms>
- Página de asset de ejemplo: <https://www.steamgriddb.com/grid/846997>
- Cliente oficial TypeScript: <https://github.com/SteamGridDB/node-steamgriddb>
- IGDB API: <https://api-docs.igdb.com/>
- Twitch Developer Services Agreement: <https://www.twitch.tv/p/legal/developer-agreement/>
- RAWG API y precios: <https://rawg.io/apidocs>
- RAWG documentación: <https://api.rawg.io/docs/>


## Integración en catálogo

El coordinador implementa el almacenamiento y la orquestación:

- `EnrichmentService` resuelve identidad, detalles y artwork en segundo plano tras
  importar un paquete. La UI recibe placeholders de inmediato.
- La caché usa SQLite (`metadata_cache`); los originales y variantes de artwork se
  guardan bajo `userData/artwork` y se sirven por `bps-media://`. El renderer nunca
  recibe rutas de archivo ni URLs remotas.
- La selección manual de artwork se guarda con `source=manual` y no se pisa al
  refrescar automáticamente. El autor/atribución/licencia se persisten y se
  muestran en la galería.
- Antes de activar SteamGridDB se exige una clave configurada y almacenada con
  DPAPI; sin clave, el proveedor local sigue activo y no se borran los datos mock.
- La preferencia de español dispara una actualización de detalles si el idioma
  guardado era otro. La falta de red o de clave nunca bloquea la instalación.
