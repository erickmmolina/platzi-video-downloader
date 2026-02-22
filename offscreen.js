// Offscreen document - Maneja Blobs para evitar OOM en el service worker
// El service worker no tiene acceso a URL.createObjectURL ni Blob API,
// así que este documento acumula segmentos como Blob parts y crea el objectURL.
// La descarga final la ejecuta el service worker via chrome.downloads.

const pendingDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message.action?.startsWith('offscreen:')) return false;

  switch (message.action) {
    case 'offscreen:initDownload': {
      const { downloadId, mimeType } = message;
      pendingDownloads.set(downloadId, {
        parts: [],
        mimeType: mimeType || 'video/mp2t',
        objectUrl: null,
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

    case 'offscreen:finalize': {
      // Crear Blob final y objectURL, enviarlo al service worker
      // El service worker usará chrome.downloads.download() con este URL
      const { downloadId } = message;
      const entry = pendingDownloads.get(downloadId);
      if (!entry) {
        sendResponse({ error: 'downloadId no encontrado' });
        return true;
      }

      try {
        const blob = new Blob(entry.parts, { type: entry.mimeType });
        const objectUrl = URL.createObjectURL(blob);
        const fileSize = blob.size;

        // Guardar objectUrl para cleanup posterior
        entry.objectUrl = objectUrl;
        // Liberar las partes individuales (el Blob final ya las contiene)
        entry.parts = [];

        sendResponse({ ok: true, objectUrl, fileSize });
      } catch (err) {
        sendResponse({ error: `Error creando Blob: ${err.message}` });
      }
      return true;
    }

    case 'offscreen:cleanup': {
      // Revocar objectURL y limpiar entrada
      const { downloadId } = message;
      const entry = pendingDownloads.get(downloadId);
      if (entry?.objectUrl) {
        URL.revokeObjectURL(entry.objectUrl);
      }
      pendingDownloads.delete(downloadId);
      sendResponse({ ok: true });
      return true;
    }
  }
});
