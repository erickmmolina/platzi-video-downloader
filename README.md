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
3. Selecciona las clases que quieres descargar
4. Elige la calidad de video (1080p, 720p, 360p)
5. Haz clic en **Descargar**

Los videos se guardan en `Descargas/Platzi/{nombre-del-curso}/` con el formato `{número}-{título}.ts`.

**Importante:** La pestaña de Platzi debe permanecer abierta durante la descarga.

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
├── popup.html           # Interfaz de usuario
├── popup.css            # Estilos
├── popup.js             # Lógica del popup
└── icons/               # Iconos de la extensión
```

## Cómo funciona

1. El **content script** detecta que estás en un curso de Platzi y extrae la lista de clases del DOM
2. El **popup** muestra las clases disponibles con checkboxes para seleccionar
3. Al descargar, el **service worker** obtiene el manifiesto HLS (`.m3u8`) de cada clase
4. Descarga todos los segmentos de video, los desencripta (AES-128) y los concatena
5. Guarda el archivo `.ts` final usando la API de descargas de Chrome

## Limitaciones

- Requiere sesión activa en Platzi (las cookies de autenticación son necesarias)
- Las clases de tipo "lectura" (sin video) se omiten automáticamente
- Los tokens de acceso son temporales, la descarga debe hacerse con sesión activa
- Si Platzi implementa DRM (Widevine/FairPlay) en algún video, ese video no se podrá descargar

## Mejoras futuras

- [ ] Conversión automática a `.mp4`
- [ ] Descarga de comentarios y resúmenes de cada clase
- [ ] Persistir el progreso si se cierra el popup
- [ ] Descarga paralela de segmentos para mayor velocidad
- [ ] Soporte para descargar recursos adjuntos (PDFs, slides)

## Aviso legal

Esta herramienta es para uso personal y educativo. Requiere una suscripción activa de Platzi. Respeta los términos de servicio de la plataforma.

## Licencia

MIT
