# Convertidor STL/3MF → STEP — versión web independiente (para iPad / Safari)

Esta es una versión "standalone" (sin extensión de navegador) del convertidor. Es la misma
lógica de conversión (OpenCASCADE compilado a WebAssembly, suavizado con límite de
desplazamiento garantizado, visor 3D) empaquetada como una página web normal, para poder
usarla desde Safari en iPad, donde no es posible instalar extensiones de Chrome/Edge.

Todo el cálculo sigue ocurriendo 100% en el dispositivo (nada se sube a ningún servidor). Por
eso mismo, esta versión no incluye guardado automático en Google Drive ni en una carpeta
sincronizada: el STEP se descarga directamente y ya queda en la app Archivos del iPad, lista
para abrir desde Shapr3D sin pasos intermedios.

## Por qué hace falta alojarla en algún sitio (no basta con abrir el archivo local)

Safari en iOS/iPadOS bloquea `fetch()` y los módulos ES (`import`) cuando la página se abre
directamente desde el sistema de archivos (`file://`). Esta página los usa para cargar
OpenCASCADE-WASM y three.js, así que necesita servirse por `https://` desde algún sitio.

La opción usada es **GitHub Pages** (gratis, URL HTTPS estable):

1. Crea un repositorio nuevo en GitHub (público, necesario para Pages gratis).
2. Sube **todos los archivos de esta carpeta directamente en la raíz del repositorio, sin
   subcarpetas** (ver nota más abajo sobre por qué está todo en un único nivel).
3. En el repositorio: **Settings → Pages → Source → Deploy from a branch**, elige la rama
   (normalmente `main`) y la carpeta raíz (`/`).
4. Espera 1-2 minutos y GitHub te da una URL del tipo
   `https://tu-usuario.github.io/tu-repo/converter.html`.
5. Abre esa URL en Safari en el iPad. Puedes añadirla a la pantalla de inicio (icono
   "Compartir" → "Añadir a pantalla de inicio") para que se abra como una app.

Alternativas igual de válidas si ya usas otra cosa: Netlify, Vercel, Cloudflare Pages, o
cualquier hosting estático que sirva por HTTPS.

### Por qué está todo en un único nivel (sin `vendor/`, sin subcarpetas)

El subidor web de GitHub ("Add file → Upload files") tiene dos límites poco documentados,
descubiertos al subir esto de verdad:

- Un archivo suelto de ~48 MB (el `.wasm` de OpenCASCADE) falla siempre con "the file is too
  large", aunque el límite oficial de GitHub es 25 MB por archivo. Trocearlo en partes de 20 MB
  tampoco bastó: seguía fallando igual, lo que apunta a un límite sobre el **total** subido de
  una vez, no solo por archivo. Con partes de 5 MB (`opencascade.full.wasm.part00` a `part10`,
  11 en total) sí funciona.
- Arrastrar varios archivos sueltos de carpetas distintas (en vez de una única carpeta real)
  aplana la estructura: todo termina en la raíz del repositorio sin importar las subcarpetas
  originales. Por eso el código de este sitio (`converter.js`, `sandbox.js`, `OrbitControls.js`)
  usa rutas relativas planas (`./three.module.js`, no `./vendor/three/three.module.js`) y todos
  los archivos van sueltos en la raíz, a propósito — así la subida es fiable sin depender de que
  el navegador conserve la jerarquía de carpetas al arrastrar.

Si en vez de la web usas `git` por línea de comandos (o GitHub Desktop) no tienes ninguna de
estas dos limitaciones, y podrías perfectamente reorganizar todo en subcarpetas si lo prefieres
— solo recuerda actualizar las rutas relativas en esos tres archivos si lo haces.

## Aviso sobre las pruebas realizadas

Esta versión se ha probado de extremo a extremo (arrastrar archivo → convertir → descargar
STEP) con Chromium sirviendo la página por HTTP normal, y funciona correctamente sin errores.
No ha sido posible probarla en Safari/WebKit real porque este entorno de desarrollo no tiene
un navegador WebKit disponible. Las APIs que usa (`fetch`, `Blob`, `ArrayBuffer`, módulos ES,
WebAssembly) son estándar y están soportadas en Safari desde hace años, así que debería
funcionar igual, pero conviene que hagas una primera prueba real en tu iPad con un archivo
pequeño antes de confiar en ella para piezas importantes.

## Flujo de trabajo completo en iPad (sin PC)

1. Navega en Safari por la web de modelos de siempre (MakerWorld, Printables, Thingiverse...)
   y descarga el STL/3MF (o el ZIP que lo contiene) — queda en la app Archivos.
2. Abre esta página (o la app que hayas añadido a la pantalla de inicio).
3. Toca la zona de arrastrar archivo y elige el STL/3MF/ZIP desde Archivos.
4. Ajusta el suavizado si quieres y pulsa "Convertir a STEP".
5. Descarga el STEP resultante (botón verde) — se guarda en Archivos.
6. Abre Shapr3D → Importar → elige el STEP desde Archivos.
7. Edita la pieza en Shapr3D.
8. Exporta desde Shapr3D (STL/3MF/gcode según tu flujo) y envíala a imprimir con la app que
   uses normalmente para tu impresora (por ejemplo Bambu Handy, si es una Bambu Lab).

Sobre el envío a imprimir: esa parte queda fuera de esta herramienta (que solo convierte
STL/3MF → STEP) — se hace con la app de tu impresora (Bambu Lab H2C), igual que ya haces
normalmente.
