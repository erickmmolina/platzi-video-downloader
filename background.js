// Service Worker - Orquesta las descargas de video
importScripts('hls-downloader.js');

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
    world: 'MAIN',
  });

  const result = results?.[0]?.result;
  if (!result || result.error) {
    throw new Error(result?.error || 'No se pudo ejecutar fetch en la página');
  }
  return result.text;
}

// =====================================================
// Fetch con reintentos y timeout
// =====================================================

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const { signal: userSignal, timeout = 30000, ...fetchOpts } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Verificar cancelación del usuario antes de intentar
      if (userSignal?.aborted) throw new DOMException('Cancelado', 'AbortError');

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

      // Combinar señales: usuario + timeout
      let signal;
      if (userSignal) {
        signal = AbortSignal.any([userSignal, timeoutController.signal]);
      } else {
        signal = timeoutController.signal;
      }

      const resp = await fetch(url, { ...fetchOpts, signal });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return resp;
    } catch (error) {
      // Si el usuario canceló, no reintentar
      if (error.name === 'AbortError' && userSignal?.aborted) {
        throw error;
      }
      if (attempt === maxRetries) {
        throw new Error(`Fallo tras ${maxRetries + 1} intentos: ${error.message}`);
      }
      // Backoff exponencial: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// =====================================================
// Offscreen Document para Blobs
// =====================================================

let offscreenDocumentCreated = false;

async function ensureOffscreenDocument() {
  if (offscreenDocumentCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });

  if (existingContexts.length > 0) {
    offscreenDocumentCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Crear Blob URLs para descargar videos sin límites de tamaño de data URL',
  });
  offscreenDocumentCreated = true;
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
  tabId: null,
  failedClasses: [],
};

let currentPageData = null;

// =====================================================
// Persistencia de estado via chrome.storage.session
// =====================================================

async function persistState() {
  try {
    await chrome.storage.session.set({
      downloadState: {
        isDownloading: downloadState.isDownloading,
        current: downloadState.current
          ? { slug: downloadState.current.slug, title: downloadState.current.title, number: downloadState.current.number }
          : null,
        queue: downloadState.queue.map((c) => ({
          slug: c.slug,
          title: c.title,
          number: c.number,
          fullUrl: c.fullUrl,
        })),
        completedCount: downloadState.completedCount,
        totalCount: downloadState.totalCount,
        courseSlug: downloadState.courseSlug,
        courseTitle: downloadState.courseTitle,
        failedClasses: downloadState.failedClasses,
      },
    });
  } catch {
    // Ignorar errores de persistencia (no crítico)
  }
}

// =====================================================
// Message handler
// =====================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignorar mensajes del offscreen document
  if (message.action?.startsWith('offscreen:')) return false;

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
    courseTitle: downloadState.courseTitle,
    failedClasses: downloadState.failedClasses,
  };
}

async function handleStartDownload(message) {
  // Guard: prevenir doble descarga
  if (downloadState.isDownloading) {
    console.warn('Descarga ya en curso, ignorando solicitud duplicada');
    return;
  }

  const { classes, courseSlug, courseTitle, quality, tabId } = message;

  downloadState.queue = [...classes];
  downloadState.courseSlug = courseSlug;
  downloadState.courseTitle = courseTitle;
  downloadState.quality = quality || 'best';
  downloadState.isDownloading = true;
  downloadState.completedCount = 0;
  downloadState.totalCount = classes.length;
  downloadState.tabId = tabId;
  downloadState.failedClasses = [];

  broadcastStatus('downloadStarted', {
    total: classes.length,
    courseTitle,
  });

  await persistState();
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
  persistState();
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
        await persistState();
        return;
      }

      console.error(`Error descargando clase ${classItem.title}:`, error);

      // Registrar clase fallida para reintentos
      downloadState.failedClasses.push({
        ...classItem,
        error: error.message,
      });

      broadcastStatus('classError', {
        classTitle: classItem.title,
        classNumber: classItem.number,
        error: error.message,
      });
    }

    await persistState();
  }

  downloadState.isDownloading = false;
  downloadState.current = null;
  downloadState.abortController = null;

  broadcastStatus('downloadComplete', {
    completedCount: downloadState.completedCount,
    totalCount: downloadState.totalCount,
    courseTitle: downloadState.courseTitle,
    failedClasses: downloadState.failedClasses,
  });

  await persistState();
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
  const signal = downloadState.abortController.signal;
  let mediaContent;

  try {
    const mediaResp = await fetchWithRetry(selected.url, { signal, timeout: 30000 });
    mediaContent = await mediaResp.text();
  } catch {
    // Si falla, intentar via contexto de página
    mediaContent = await fetchInPageContext(tabId, selected.url);
  }

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
    const keyResp = await fetchWithRetry(segments[0].encryption.keyUrl, { signal, timeout: 15000 });
    if (!keyResp.ok) throw new Error(`Error descargando clave: ${keyResp.status}`);
    const keyData = await keyResp.arrayBuffer();
    cryptoKey = await crypto.subtle.importKey('raw', keyData, { name: 'AES-CBC' }, false, [
      'decrypt',
    ]);
  }

  // Inicializar offscreen document para acumular segmentos como Blob
  await ensureOffscreenDocument();
  const downloadId = `${classItem.slug}-${Date.now()}`;
  await chrome.runtime.sendMessage({
    action: 'offscreen:initDownload',
    downloadId,
    mimeType: 'video/mp2t',
  });

  // Descargar segmentos uno por uno, enviando cada uno al offscreen inmediatamente
  let totalBytes = 0;
  const startTime = Date.now();

  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) throw new DOMException('Descarga cancelada', 'AbortError');

    const segment = segments[i];
    const segResp = await fetchWithRetry(segment.url, { signal, timeout: 60000 });
    let data = await segResp.arrayBuffer();

    if (segment.encryption && cryptoKey) {
      data = await HLSDownloader.decryptSegment(data, cryptoKey, segment.encryption.iv);
    }

    totalBytes += data.byteLength;

    // Enviar segmento al offscreen document (el SW libera `data` después)
    await chrome.runtime.sendMessage({
      action: 'offscreen:addSegment',
      downloadId,
      segmentData: data,
    });

    // Calcular velocidad y ETA
    const elapsedSec = (Date.now() - startTime) / 1000;
    const speedBps = elapsedSec > 0 ? totalBytes / elapsedSec : 0;
    const remainingSegments = segments.length - (i + 1);
    const avgSegmentBytes = totalBytes / (i + 1);
    const etaSeconds = speedBps > 0 ? Math.round((remainingSegments * avgSegmentBytes) / speedBps) : 0;

    broadcastStatus('downloadProgress', {
      classTitle: classItem.title,
      classNumber: classItem.number,
      segmentIndex: i + 1,
      totalSegments: segments.length,
      bytesDownloaded: totalBytes,
      percent: Math.round(((i + 1) / segments.length) * 100),
      speedBps,
      etaSeconds,
    });
  }

  // Finalizar: crear Blob + objectURL en el offscreen
  const finalizeResult = await chrome.runtime.sendMessage({
    action: 'offscreen:finalize',
    downloadId,
  });

  if (!finalizeResult?.ok) {
    throw new Error(finalizeResult?.error || 'Error creando archivo de video');
  }

  // Guardar archivo
  const safeTitle = sanitizeFilename(classItem.title);
  const number = String(classItem.number).padStart(2, '0');
  const courseFolder = sanitizeFilename(downloadState.courseTitle || downloadState.courseSlug);
  const filename = `Platzi/${courseFolder}/${number}-${safeTitle}.ts`;

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: finalizeResult.url, filename, saveAs: false },
      (dlId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        const listener = (delta) => {
          if (delta.id !== dlId) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            resolve();
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            reject(new Error('Descarga interrumpida'));
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });

  // Limpiar objectURL en el offscreen
  await chrome.runtime.sendMessage({
    action: 'offscreen:cleanup',
    downloadId,
  });
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
