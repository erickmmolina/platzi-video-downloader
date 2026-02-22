// Service Worker - Orquesta las descargas de video
importScripts('hls-downloader.js');
importScripts('vendor/mux.min.js');

// =====================================================
// Fetch autenticado via executeScript (en contexto de página)
// =====================================================

/**
 * Ejecuta un fetch en el contexto de la página de Platzi (tab),
 * donde las cookies de sesión están disponibles automáticamente.
 */
async function fetchInPageContext(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (fetchUrl) => {
      try {
        const resp = await fetch(fetchUrl, { credentials: 'include' });
        if (!resp.ok) {
          return { error: `HTTP ${resp.status}`, status: resp.status };
        }
        const text = await resp.text();
        return { ok: true, text, status: resp.status };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [url],
    world: 'MAIN', // Ejecutar en el contexto de la página web, no del content script
  });

  const result = results?.[0]?.result;
  if (!result || result.error) {
    throw new Error(result?.error || 'No se pudo ejecutar fetch en la página');
  }
  return result.text;
}

// =====================================================
// Estado global de descargas
// =====================================================
const downloadState = {
  queue: [],
  current: null,
  isDownloading: false,
  abortController: null,
  courseSlug: null,
  courseTitle: null,
  quality: 'best',
  completedCount: 0,
  totalCount: 0,
  tabId: null, // Tab de Platzi para executeScript
};

let currentPageData = null;

// =====================================================
// Message handler
// =====================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'pageLoaded':
      currentPageData = message.data;
      if (message.data.classes?.length > 0 && sender.tab?.id) {
        chrome.action.setBadgeText({
          text: String(message.data.classes.length),
          tabId: sender.tab.id,
        });
        chrome.action.setBadgeBackgroundColor({ color: '#98CA3F' });
      }
      break;

    case 'getPageData':
      sendResponse(currentPageData);
      return true;

    case 'startDownload':
      handleStartDownload(message);
      sendResponse({ ok: true });
      return true;

    case 'cancelDownload':
      handleCancelDownload();
      sendResponse({ ok: true });
      return true;

    case 'getDownloadStatus':
      sendResponse(getDownloadStatus());
      return true;
  }
});

function getDownloadStatus() {
  return {
    isDownloading: downloadState.isDownloading,
    current: downloadState.current,
    queue: downloadState.queue.map((c) => ({ slug: c.slug, title: c.title, number: c.number })),
    completedCount: downloadState.completedCount,
    totalCount: downloadState.totalCount,
  };
}

async function handleStartDownload(message) {
  const { classes, courseSlug, courseTitle, quality, tabId } = message;

  downloadState.queue = [...classes];
  downloadState.courseSlug = courseSlug;
  downloadState.courseTitle = courseTitle;
  downloadState.quality = quality || 'best';
  downloadState.isDownloading = true;
  downloadState.completedCount = 0;
  downloadState.totalCount = classes.length;
  downloadState.tabId = tabId;

  broadcastStatus('downloadStarted', {
    total: classes.length,
    courseTitle,
  });

  processQueue();
}

function handleCancelDownload() {
  if (downloadState.abortController) {
    downloadState.abortController.abort();
  }
  downloadState.queue = [];
  downloadState.isDownloading = false;
  downloadState.current = null;
  downloadState.abortController = null;

  broadcastStatus('downloadCancelled');
}

async function processQueue() {
  while (downloadState.queue.length > 0 && downloadState.isDownloading) {
    const classItem = downloadState.queue.shift();
    downloadState.current = classItem;
    downloadState.abortController = new AbortController();

    broadcastStatus('classStarted', {
      classTitle: classItem.title,
      classNumber: classItem.number,
      remaining: downloadState.queue.length,
    });

    try {
      await downloadClass(classItem);
      downloadState.completedCount++;

      broadcastStatus('classCompleted', {
        classTitle: classItem.title,
        classNumber: classItem.number,
        completedCount: downloadState.completedCount,
        totalCount: downloadState.totalCount,
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        broadcastStatus('downloadCancelled');
        return;
      }

      console.error(`Error descargando clase ${classItem.title}:`, error);
      broadcastStatus('classError', {
        classTitle: classItem.title,
        classNumber: classItem.number,
        error: error.message,
      });
    }
  }

  downloadState.isDownloading = false;
  downloadState.current = null;
  downloadState.abortController = null;

  broadcastStatus('downloadComplete', {
    completedCount: downloadState.completedCount,
    totalCount: downloadState.totalCount,
  });
}

async function downloadClass(classItem) {
  const tabId = downloadState.tabId;

  // 1. Obtener la URL del m3u8: fetch de la página de la clase en contexto de página
  const pageHtml = await fetchInPageContext(tabId, classItem.fullUrl);

  const videoMatch = pageHtml.match(
    /https:\/\/api\.platzi\.com\/mdstrm\/v1\/video\/([a-f0-9]+)\.m3u8/
  );
  if (!videoMatch) {
    throw new Error('No se encontró video (puede ser una lectura)');
  }
  const m3u8Url = videoMatch[0];

  // 2. Fetch del master playlist en contexto de página (necesita cookies)
  const masterContent = await fetchInPageContext(tabId, m3u8Url);

  // 3. Parsear variantes y seleccionar calidad
  const variants = HLSDownloader.parseMasterPlaylist(masterContent);
  if (variants.length === 0) throw new Error('No se encontraron variantes de video');

  let selected;
  if (downloadState.quality === 'best') {
    selected = variants[0];
  } else {
    selected = variants.find((v) => v.resolution.includes(downloadState.quality)) || variants[0];
  }

  // 4. Desde aquí, las URLs de mediastream ya tienen auth en los parámetros de URL.
  //    El service worker puede hacer fetch directo sin cookies.
  const mediaResp = await fetch(selected.url, {
    signal: downloadState.abortController.signal,
  });
  if (!mediaResp.ok) {
    // Si falla, intentar via contexto de página
    const mediaContent = await fetchInPageContext(tabId, selected.url);
    return await downloadSegments(mediaContent, selected.url, classItem);
  }
  const mediaContent = await mediaResp.text();
  await downloadSegments(mediaContent, selected.url, classItem);
}

async function downloadSegments(mediaContent, mediaUrl, classItem) {
  const signal = downloadState.abortController.signal;
  const baseUrl = mediaUrl.split('?')[0].replace(/\/[^/]+$/, '/');
  const { segments } = HLSDownloader.parseMediaPlaylist(mediaContent, baseUrl);

  if (segments.length === 0) throw new Error('No se encontraron segmentos de video');

  // Descargar clave de encriptación si es necesario
  let cryptoKey = null;
  if (segments[0].encryption) {
    const keyResp = await fetch(segments[0].encryption.keyUrl, { signal });
    if (!keyResp.ok) throw new Error(`Error descargando clave: ${keyResp.status}`);
    const keyData = await keyResp.arrayBuffer();
    cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-CBC' }, false, [
      'decrypt',
    ]);
  }

  // Inicializar transmuxer TS → MP4 (mux.js)
  const transmuxer = new muxjs.mp4.Transmuxer();
  const mp4Chunks = [];
  let initSegment = null;

  transmuxer.on('data', (segment) => {
    if (!initSegment) {
      initSegment = new Uint8Array(segment.initSegment);
    }
    mp4Chunks.push(new Uint8Array(segment.data));
  });

  // Descargar, desencriptar y transmuxear segmentos
  let totalBytes = 0;

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) throw new DOMException('Descarga cancelada', 'AbortError');

    const segment = segments[i];
    const segResp = await fetch(segment.url, { signal });
    if (!segResp.ok)
      throw new Error(`Error descargando segmento ${i + 1}/${segments.length}: ${segResp.status}`);

    let data = await segResp.arrayBuffer();

    if (segment.encryption && cryptoKey) {
      data = await HLSDownloader.decryptSegment(data, cryptoKey, segment.encryption.iv);
    }

    // Push al transmuxer (convierte TS → MP4 incrementalmente)
    transmuxer.push(new Uint8Array(data));
    totalBytes += data.byteLength;

    broadcastStatus('downloadProgress', {
      classTitle: classItem.title,
      classNumber: classItem.number,
      segmentIndex: i + 1,
      totalSegments: segments.length,
      bytesDownloaded: totalBytes,
      percent: Math.round(((i + 1) / segments.length) * 100),
    });
  }

  // Flush para obtener datos restantes del transmuxer
  transmuxer.flush();

  if (!initSegment || mp4Chunks.length === 0) {
    throw new Error('Error al convertir video a MP4');
  }

  // Combinar init segment (ftyp + moov) + chunks MP4 (moof + mdat)
  let totalLength = initSegment.byteLength;
  for (const chunk of mp4Chunks) {
    totalLength += chunk.byteLength;
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;

  combined.set(initSegment, offset);
  offset += initSegment.byteLength;

  for (const chunk of mp4Chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Guardar archivo como .mp4
  const safeTitle = sanitizeFilename(classItem.title);
  const number = String(classItem.number).padStart(2, '0');
  const courseFolder = sanitizeFilename(downloadState.courseTitle || downloadState.courseSlug);
  const filename = `Platzi/${courseFolder}/${number}-${safeTitle}.mp4`;

  const dataUrl = uint8ArrayToDataUrl(combined, 'video/mp4');

  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (delta.state?.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error('Descarga interrumpida'));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

function uint8ArrayToDataUrl(uint8Array, mimeType) {
  let binary = '';
  const chunkSize = 0x8000; // 32KB chunks para evitar stack overflow
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

function broadcastStatus(event, data = {}) {
  chrome.runtime
    .sendMessage({
      action: 'downloadStatus',
      event,
      ...data,
      ...getDownloadStatus(),
    })
    .catch(() => {
      // Popup puede estar cerrado, ignorar
    });
}
