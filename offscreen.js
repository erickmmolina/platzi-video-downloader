// Offscreen document - Maneja Blobs para evitar OOM en el service worker
// El service worker no tiene acceso a URL.createObjectURL, pero este documento sí.

const pendingDownloads = new Map(); // downloadId -> { parts: Blob[], mimeType: string, objectUrl: string|null }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Solo procesar mensajes del offscreen
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
      // segmentData llega como ArrayBuffer via structured clone
      const blob = new Blob([segmentData]);
      entry.parts.push(blob);
      sendResponse({ ok: true, partsCount: entry.parts.length });
      return true;
    }

    case 'offscreen:finalize': {
      const { downloadId } = message;
      const entry = pendingDownloads.get(downloadId);
      if (!entry) {
        sendResponse({ error: 'downloadId no encontrado' });
        return true;
      }
      const blob = new Blob(entry.parts, { type: entry.mimeType });
      const url = URL.createObjectURL(blob);
      // Limpiar partes para liberar memoria, mantener referencia al objectURL
      entry.parts = [];
      entry.objectUrl = url;
      sendResponse({ ok: true, url, size: blob.size });
      return true;
    }

    case 'offscreen:cleanup': {
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
