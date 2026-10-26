# Artwork local

Módulo `src/core/artwork`. No importa Electron, React ni base de datos. La
persistencia, la URL de preview y la descarga se inyectan para que el
coordinador las conecte con `safeStorage`, el sistema de archivos y SQLite.

## Flujo

1. El proveedor lista candidatos (`ArtworkCandidate`) con URL, tipo, dimensiones,
   estilo, origen (`provider`/`mock`), autor y atribución cuando existen.
2. `ArtworkIngestor` descarga el candidato con `ControlledArtworkDownloader`.
3. Se valida el contenido real con sharp, no solo el MIME declarado.
4. Se conserva el original sin recompresión y se calcula su SHA-256.
5. Se genera **solo** la variante correspondiente al tipo del candidato.
6. Si se inyecta `ArtworkStorage`, se guardan original y variante con claves
   estables (`<sha256>/original.<ext>` y `<sha256>/<kind>.png`).
7. `buildArtworkView` convierte el resultado en `ArtworkView` con la URL de
   preview que decida el coordinador.

## Descarga controlada

`ControlledArtworkDownloader`:

- Solo HTTPS contra `cdn.steamgriddb.com` y `cdn2.steamgriddb.com` (lista
  verificada el 2026-10-26). No se aceptan otros hosts.
- Rechaza credenciales en la URL, `file:`, `blob:`, `ftp:` y redirecciones a
  hosts no permitidos.
- Redirecciones manuales, máximo 3, revalidadas en cada salto.
- Timeout por defecto 15 s y tamaño máximo 15 MB. El límite se aplica a
  `Content-Length` y también al flujo real, porque la cabecera puede faltar o
  mentir.
- MIME declarado permitido: `image/png`, `image/jpeg`, `image/webp`. Un
  `text/html`, `image/svg+xml` u otro tipo se rechaza antes de decodificar.
- `AbortSignal` externo y timeout se propagan al `fetch`.
- El proveedor mock usa `data:image/png;base64,...`. Los data URLs se decodifican
  con validación estricta de base64, tamaño y tipo raster; los data URLs SVG se
  rechazan. Un `file:` no se acepta.

El flag `allowInsecureLocalhost` existe **solo para tests** y permite HTTP
contra loopback. En producción debe quedar en `false`.

## Validación real

`detectImage` abre los bytes con sharp:

- `failOn: 'error'` y `limitInputPixels` (40 megapíxeles por defecto).
- Formatos aceptados: `png`, `jpeg`, `webp`. Un SVG se rechaza explícitamente
  (`ARTWORK_INVALID`, `reason: svg_not_allowed`).
- GIF, BMP, TIFF, PDF, etc. se rechazan aunque sharp pueda abrirlos.
- Si el MIME declarado es de imagen pero el contenido es texto/HTML, la
  validación real falla.
- Un tamaño de bytes excesivo produce `ARTWORK_TOO_LARGE`; un formato/contenido
  inválido produce `ARTWORK_INVALID`.

Códigos:

| Código | Cuándo |
|---|---|
| `ARTWORK_INVALID` | Origen no permitido, SVG, formato no soportado, MIME/contenido falso, redirección insegura |
| `ARTWORK_TOO_LARGE` | Bytes o píxeles por encima del límite |
| `ARTWORK_DOWNLOAD_FAILED` | Red, timeout, cancelación, estado HTTP de la CDN, exceso de redirecciones |
| `IO_ERROR` | Fallo del `ArtworkStorage` inyectado |

## Variantes

| Tipo | Salida | Regla |
|---|---|---|
| `portrait` | 600x900 | cover + center-crop, sin deformar |
| `hero` | 1920x620 | cover, sin deformar |
| `logo` | máx. 1000x400 | contain, sin ampliar, PNG con alfa si el original lo tiene |
| `icon` | 256x256 | cover |
| `screenshot` | máx. 1920x1080 | contain sin ampliar, conserva aspecto |

Notas:

- El original **nunca** se modifica ni se recodifica; se guarda aparte.
- La salida de variantes es PNG. El logo conserva transparencia; si el asset de
  origen es opaco no se inventa un fondo transparente.
- El recorte portrait/hero/icon usa `fit: cover` y posición central. La
  comprobación de recorte correcto se prueba con una imagen con círculo central
  y se leen píxeles del resultado.
- `renderArtworkVariant` no convierte entre tipos: un candidato portrait no se
  usa para generar un hero.

## Selección y ranking

`rankArtworkCandidates` / `selectArtworkCandidate`:

- Descarta candidatos de un tipo distinto.
- Exige relación de aspecto compatible para `portrait`, `hero`, `icon` y
  `screenshot`:
  - portrait: 2:3, tolerancia relativa 25 %
  - hero: 1920:620, tolerancia 28 %
  - icon: 1:1, tolerancia 12 %
  - screenshot: 16:9, tolerancia 30 %
  - logo: sin ratio fijo, pero limitado al tamaño de salida.
- Un candidato **sin dimensiones** no se auto-selecciona para tipos con aspecto;
  no se puede demostrar que no sea un retrato.
- Puntúa relación de aspecto, resolución, estilo (official en logo/icon,
  alternate en hero, material/custom/demo), contenido mock y atribución.
- Descarta etiquetas `nsfw`, `humor` y `epilepsy` salvo `allowSensitive: true`.
- Desempata de forma determinista: mayor puntuación, más píxeles, y después
  `providerAssetId` lexicográfico.

Por eso un portrait etiquetado por error como hero se descarta por aspecto y
nunca se usa como hero.

## Preferencia manual

`ArtworkView.source` distingue `provider` de `manual`.

- `selectGalleryArtwork(items, id)` marca un único elemento como `selected`,
  `chosen` y `source: 'manual'`.
- `buildArtworkGallery` con `current.source === 'manual'` no selecciona otro ID
  aunque cambie la lista del proveedor o se pase otro `selectedId`.
- `canAutoReplaceArtwork(current)` devuelve `false` para una selección manual.
- `reconcileArtworkSelection(current, incoming, { force })` conserva la manual
  salvo que el usuario fuerce explícitamente la sustitución.
- `markManualArtwork(view)` normaliza una selección manual.
- El coordinador persiste `ArtworkSet`; no se sobrescribe una entrada manual en
  actualizaciones automáticas.

## Galería

`buildArtworkGallery(candidates, options)` devuelve `ArtworkGalleryItem[]`
ordenados. Opciones:

- `kind`: limita a un tipo.
- `selectedId`: selección previa.
- `current`: `ArtworkView` persistida; si es manual, bloquea cambios.
- `autoSelect`: elige el mejor candidato por tipo.
- `now`: reloj inyectable para tests.

`galleryArtworkSet(items)` genera el `ArtworkSet` parcial con los seleccionados.
El coordinador adapta esto a IPC sin que este módulo conozca Electron.

## Placeholder

`createPlaceholderArtwork({ title, kind, initials? })`:

- Genera arte propio con SVG + sharp, sin IA ni imágenes de terceros.
- Usa iniciales, título, una paleta determinista y la etiqueta `SIN ARTWORK`.
- Tamaños: 600x900, 1920x620, 1000x400, 256x256 y 1920x1080 según el tipo.
- El logo es PNG transparente.
- Es determinista para el mismo título.
- Escapa XML y rechaza títulos vacíos.

## Persistencia e integración

Interfaces:

```ts
interface ArtworkDownloader {
  download(url: string, options?: ArtworkDownloadOptions): Promise<ArtworkDownload>
}

interface ArtworkStorage {
  put(key: string, bytes: Uint8Array, info: ArtworkStorageInfo): Promise<StoredArtworkBlob>
}
```

`ArtworkIngestor` devuelve `IngestedArtwork` con:

- `original`: bytes, MIME real, formato, dimensiones, SHA-256 y claves de
  almacenamiento, si se guardó.
- `variant`: tipo, bytes PNG, dimensiones, SHA-256 y claves.
- `provider`, `providerGameId`, candidato y `createdAt`.

`MemoryArtworkStorage` está incluido para tests y para arrancar; el coordinador
debe implementar el almacenamiento definitivo. `ArtworkView.id` puede ser el
hash del original o el ID del candidato en la galería; lo importante es que una
selección manual se marque como tal antes de persistirla.

## SteamGridDB: límites de arte

- Solo hay `portrait`, `hero`, `logo` e `icon`. **No hay screenshots.**
- El logo puede ser PNG o WebP; no hay garantía de que todos los assets tengan
  transparencia. Se conserva el alfa si existe.
- La API no aporta licencia por imagen. Se muestra autor/atribución, pero no se
  afirma que el asset sea reutilizable.
- Los hosts permitidos se verificaron con `HEAD` el 2026-10-26:
  `cdn.steamgriddb.com` y `cdn2.steamgriddb.com`.
- No se construyen URLs de CDN a partir de IDs: se usa la URL de la API tras la
  allowlist.
- Uso personal/no comercial según los Términos de SGDB; la caché es local y no
  se redistribuye. Ver `docs/metadata-providers.md`.

## Fixtures

`fixtures/artwork` contiene arte original del proyecto:

- `example-quest-portrait.svg/png` 600x900
- `example-quest-hero.svg/png` 1920x620
- `example-quest-logo.svg/png` 1000x400 transparente
- `example-quest-icon.svg/png` 256x256
- `example-quest-screenshot-1.svg/png` y `-2` 1280x720

Los PNG se generaron con sharp a partir de los SVG. No se copió arte de SGDB,
IGDB, RAWG ni de juegos comerciales. Los tests usan estos fixtures y un servidor
HTTP local que se cierra al terminar; no hay descargas reales.

## Pruebas

`npx vitest run tests/metadata tests/artwork` cubre, entre otros:

- hit/miss/expiración/offline/errores de caché;
- secuelas, remake/remaster, edición, año, ambigüedad e IDs del manifiesto;
- SGDB con servidor local/fake fetch: Bearer, filtros, 429/Retry-After, 5xx,
  timeout, abort, tamaño de respuesta y redacción de la clave;
- imagen válida, no-imagen, MIME falso, SVG remoto, tamaño excesivo, píxeles,
  crop, dimensiones y origen no permitido;
- originales conservados, ranking por aspecto, preferencia manual, galería,
  placeholder e integración con el arte mock.
