# Formato `.game` y manifiesto v1

Un `.game` es un **ZIP estándar** con otra extensión. Se puede inspeccionar
renombrándolo a `.zip`.

```
MiJuego.game
├── manifest.json
└── payload/
    ├── setup.exe
    ├── data-1.bin
    └── ...
```

- Se conserva la estructura completa de `payload/`.
- No se exigen imágenes ni descripciones dentro del paquete.
- El paquete nunca se modifica para guardar metadatos o resultados: esos datos
  viven en la base local.
- El esquema generado está en [`schema/manifest.schema.json`](../schema/manifest.schema.json)
  y tiene `schemaVersion: 1`.
- El validador real es Zod (`src/shared/manifest.ts`); el JSON Schema se genera
  desde él con `npm run schema`.

## Reglas del manifiesto

- Objeto estricto: cualquier propiedad desconocida invalida el manifiesto.
  **No hay scripts, hooks, `eval`, shell ni comandos arbitrarios.**
- `metadata` es opcional. `name` es la consulta inicial; `searchTitle`,
  `releaseYear` y `edition` son pistas. `providerIds` fija identidades ya
  confirmadas y no se exige al usuario que busque IDs.
- `id` es estable y distinto de los IDs de proveedores y de los accesos de Steam.
- `installation.executable` y `workingDirectory` son rutas **relativas al ZIP** y
  deben estar dentro de `payload/`.
- `launch.executable` y `launch.workingDirectory` son rutas **relativas a la
  instalación final**.
- Los argumentos solo admiten la variable `{installDir}`. Cualquier otra variable
  o llave suelta se rechaza. Los argumentos no se evalúan con shell.
- `successExitCodes` y `rebootRequiredExitCodes` no pueden solaparse.
- La verificación exige al menos un archivo o directorio. Se comprueba que sean
  regulares (no enlaces), que no estén vacíos y que su tamaño sea estable.
- `requiresElevation` se declara y se ejecuta mediante un auxiliar aislado que
  eleva solo el setup. UAC requiere intervención manual y no se controla con el
  mando; ver [límites](known-limits.md).

## Ejemplo verificado

[`demo/manifest.json`](../demo/manifest.json) describe el instalador demo propio.
Ese instalador admite `/S` y `/DIR=...` porque se ha escrito para ello. **No se
deben copiar estos argumentos a otro setup.exe**: cada instalador tiene sus
propias opciones y debe verificarse antes.

```json
{
  "schemaVersion": 1,
  "id": "example-quest",
  "name": "Example Quest",
  "version": "1.0.0",
  "metadata": { "searchTitle": "Example Quest", "releaseYear": 2026 },
  "installation": {
    "type": "executable",
    "profile": "demo",
    "executable": "payload/setup.exe",
    "workingDirectory": "payload",
    "arguments": ["/S", "/DIR={installDir}"],
    "successExitCodes": [0],
    "verification": {
      "requiredFiles": ["bin/ExampleQuest.exe", "data/level1.dat"],
      "timeoutSeconds": 10
    }
  },
  "launch": {
    "executable": "bin/ExampleQuest.exe",
    "workingDirectory": "bin"
  },
  "steam": {
    "enabled": true,
    "displayName": "Example Quest",
    "tags": ["BPSteamFit", "Local Games"]
  }
}
```

## Perfiles

Los perfiles `generic`, `inno`, `nsis` y `demo` son **informativos** para la UI y
la documentación. No inyectan ni reescriben argumentos. `inno`/`nsis` emiten
avisos si los argumentos no parecen silenciosos, pero el paquete sigue validando.
El motor siempre hace lo mismo: ejecutar el setup directamente, esperar su salida
y verificar los archivos declarados. Esto evita prometer instalaciones silenciosas
donde el instalador no las soporta.

## Validación de importación

Al importar se comprueba:

1. ZIP legible y entradas seguras (sin rutas absolutas, `..`, UNC, dispositivos,
   enlaces simbólicos, cifrado, colisiones de mayúsculas, límites de tamaño/ratio,
   nombres reservados de Windows, caracteres de control).
2. `manifest.json` en la raíz, JSON válido, esquema soportado.
3. Solo `manifest.json` y `payload/**` en la raíz.
4. Existencia del setup y del directorio de trabajo referenciados.
5. ID/version/hash para detectar duplicados, conflictos y versiones.
6. El payload **no se extrae** para listar el juego.

Un ZIP válido no vuelve seguro a `setup.exe`: al instalar se vuelve a validar el
hash y se exige confirmación del usuario.

## CLI

```powershell
npm run gamepack -- validate "C:\Ruta\MiJuego.game"
npm run gamepack -- inspect "C:\Ruta\MiJuego.game"
npm run gamepack -- create --manifest .\manifest.json --payload .\payload --out .\MiJuego.game
```

También se puede compilar el CLI:

```powershell
npm run build:cli
node dist/cli/gamepack.cjs validate .\MiJuego.game
```

Códigos de salida: `0` éxito, `1` error de validación, `2` uso incorrecto.

## Paquete demo

```powershell
npm run demo
```

Genera `demo/out/ExampleQuest.game` compilando un instalador y un juego WinForms
inocuos desde C# con `csc.exe` de .NET Framework. Las pruebas lo regeneran de
forma reproducible y no usan contenido comercial.
