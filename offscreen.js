// Offscreen document - Maneja Blobs y descargas para evitar OOM en el service worker
// El service worker no tiene acceso a URL.createObjectURL, y los blob URLs
// creados aquí no son accesibles desde otros contextos, así que este documento
// también ejecuta la descarga final.

const pendingDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message.action?.startsWith('offscreen:')) return false;

  switch (message.action) {
    case 'offscreen:initDownload': {
      const { downloadId, mimeType } = message;
      pendingDownloads.set(downloadId, {
        parts: [],
        mimeType: mimeType || 'video/mp2t',
      });
      sendResponse({ ok: true });
      return true;
    }

    case 'offscreen:addSegment': {
      const { downloadId, segmentData } = message;
      const entry = pendingDownloads.get(downloadId);
      if (!entry) {
        sendResponse({ error: 'downloadId no encontrado' });
        return true;
      }

      // segmentData llega como Array<number> desde el service worker
      // (se convierte a Uint8Array para garantizar compatibilidad de serialización)
      try {
        const uint8 = new Uint8Array(segmentData);
        const blob = new Blob([uint8]);
        entry.parts.push(blob);
        sendResponse({ ok: true, partsCount: entry.parts.length });
      } catch (err) {
        sendResponse({ error: `Error procesando segmento: ${err.message}` });
      }
      return true;
    }

    case 'offscreen:download': {
      // Crear Blob final, objectURL, ejecutar descarga y limpiar
      const { downloadId, filename } = message;
      const entry = pendingDownloads.get(downloadId);
      if (!entry) {
        sendResponse({ error: 'downloadId no encontrado' });
        return true;
      }

      // Crear Blob y objectURL
      const blob = new Blob(entry.parts, { type: entry.mimeType });
      const objectUrl = URL.createObjectURL(blob);
      const fileSize = blob.size;

      // Limpiar partes para liberar memoria
      entry.parts = [];

      // Ejecutar la descarga desde ESTE contexto (donde el blob URL es válido)
      chrome.downloads.download(
        { url: objectUrl, filename, saveAs: false },
        (dlId) => {
          if (chrome.runtime.lastError) {
            URL.revokeObjectURL(objectUrl);
            pendingDownloads.delete(downloadId);
            sendResponse({ error: chrome.runtime.lastError.message });
            return;
          }

          // Esperar a que la descarga termine
          const listener = (delta) => {
            if (delta.id !== dlId) return;

            if (delta.state?.current === 'complete') {
              chrome.downloads.onChanged.removeListener(listener);
              URL.revokeObjectURL(objectUrl);
              pendingDownloads.delete(downloadId);
              sendResponse({ ok: true, size: fileSize });
            } else if (delta.state?.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(listener);
              URL.revokeObjectURL(objectUrl);
              pendingDownloads.delete(downloadId);
              sendResponse({ error: 'Descarga interrumpida' });
            }
          };
          chrome.downloads.onChanged.addListener(listener);
        }
      );

      return true; // Mantener canal abierto para respuesta async
    }

    case 'offscreen:cleanup': {
      // Limpieza manual por si algo falla
      const { downloadId } = message;
      pendingDownloads.delete(downloadId);
      sendResponse({ ok: true });
      return true;
    }
  }
});
