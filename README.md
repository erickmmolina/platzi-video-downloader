# Platzi Video Downloader

Extensión de Chrome para descargar los videos de tus cursos de Platzi y verlos offline.

## Requisitos

- Google Chrome (o cualquier navegador basado en Chromium)
- Una suscripción activa de Platzi

## Instalación

1. Clona o descarga este repositorio
2. Abre `chrome://extensions/` en tu navegador
3. Activa el **Modo de desarrollador** (esquina superior derecha)
4. Haz clic en **Cargar extensión sin empaquetar**
5. Selecciona la carpeta del proyecto

## Uso

1. Navega a cualquier curso de Platzi (ej: `platzi.com/cursos/tu-curso/`)
2. Haz clic en el icono de la extensión en la barra de herramientas
3. Selecciona las clases que quieres descargar (usa la búsqueda para filtrar)
4. Elige la calidad de video (1080p, 720p, 360p)
5. Haz clic en **Descargar**

Los videos se guardan en `Descargas/Platzi/{nombre-del-curso}/` con el formato `{número}-{título}.ts`.

**Importante:** La pestaña de Platzi debe permanecer abierta durante la descarga.

## Características (v2.0)

- **Descarga robusta**: Reintentos automáticos con backoff exponencial ante fallos de red
- **Bajo consumo de memoria**: Usa Offscreen Document con Blob API para evitar OOM en videos largos
- **Progreso detallado**: Velocidad de descarga (MB/s) y tiempo estimado (ETA)
- **Búsqueda de clases**: Filtra clases por título en tiempo real
- **Reintentar fallidas**: Botón para reintentar solo las clases que fallaron
- **Persistencia de sesión**: El estado se mantiene si cierras y reabres el popup
- **Resumen post-descarga**: Muestra resumen de clases descargadas, fallidas y ubicación
- **Seguridad**: Sin vulnerabilidades XSS, permisos mínimos
- **Accesibilidad**: Navegación por teclado, roles ARIA, focus visible

## Formato de video

Los videos se descargan en formato `.ts` (MPEG Transport Stream), que es reproducible en:

- **VLC** (todas las plataformas)
- **IINA** (macOS)
- **mpv** (todas las plataformas)
- **QuickTime** (macOS)

### Convertir a MP4 (opcional)

Si prefieres formato `.mp4`, puedes usar `ffmpeg` para convertir sin pérdida de calidad:

```bash
# Instalar ffmpeg (macOS)
brew install ffmpeg

# Convertir un archivo
ffmpeg -i "01-Mi clase.ts" -c copy "01-Mi clase.mp4"

# Convertir todos los archivos de una carpeta
for f in *.ts; do ffmpeg -i "$f" -c copy "${f%.ts}.mp4"; done
```

## Estructura del proyecto

```
platzi-video-downloader/
├── manifest.json        # Configuración de la extensión (Manifest V3)
├── content.js           # Extrae información del curso desde el DOM
├── background.js        # Service worker - orquesta las descargas
├── hls-downloader.js    # Descarga y desencripta streams HLS
├── offscreen.html       # Documento offscreen para manejo de Blobs
├── offscreen.js         # Lógica del offscreen (Blob + objectURL)
├── popup.html           # Interfaz de usuario
├── popup.css            # Estilos
├── popup.js             # Lógica del popup
└── icons/               # Iconos de la extensión
```

## Cómo funciona

1. El **content script** detecta que estás en un curso de Platzi y extrae la lista de clases del DOM
2. El **popup** muestra las clases disponibles con checkboxes para seleccionar
3. Al descargar, el **service worker** obtiene el manifiesto HLS (`.m3u8`) de cada clase
4. Descarga segmentos de video uno por uno, los desencripta (AES-128) y los envía al **offscreen document**
5. El offscreen document acumula los segmentos como Blob parts (eficiente en memoria)
6. Al completar, crea un `objectURL` del Blob y el service worker descarga el archivo `.ts` final

## Arquitectura de memoria

```
Service Worker                Offscreen Document
┌──────────────┐              ┌──────────────────┐
│ fetch seg 1  │──send───────>│ Blob part 1      │
│ (libera)     │              │                  │
│ fetch seg 2  │──send───────>│ Blob part 2      │
│ (libera)     │              │                  │
│ ...          │              │ ...              │
│ finalize     │──request────>│ new Blob(parts)  │
│              │<─objectURL───│ createObjectURL   │
│ download()   │              │                  │
│ cleanup      │──request────>│ revokeObjectURL  │
└──────────────┘              └──────────────────┘

Memoria del SW: ~1 segmento (2-6MB) vs ~video completo (100-500MB)
```

## Limitaciones

- Requiere sesión activa en Platzi (las cookies de autenticación son necesarias)
- Las clases de tipo "lectura" (sin video) se omiten automáticamente
- Los tokens de acceso son temporales, la descarga debe hacerse con sesión activa
- Si Platzi implementa DRM (Widevine/FairPlay) en algún video, ese video no se podrá descargar

## Mejoras futuras

- [ ] Conversión automática a `.mp4`
- [ ] Descarga de comentarios y resúmenes de cada clase
- [ ] Descarga paralela de segmentos para mayor velocidad
- [ ] Soporte para descargar recursos adjuntos (PDFs, slides)
- [ ] Resumen pre-descarga (espacio estimado, cantidad de clases)

## Aviso legal

Esta herramienta es para uso personal y educativo. Requiere una suscripción activa de Platzi. Respeta los términos de servicio de la plataforma.

## Licencia

MIT
