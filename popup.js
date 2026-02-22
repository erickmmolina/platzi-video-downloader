document.addEventListener('DOMContentLoaded', async () => {
  // Elementos del DOM
  const stateNotPlatzi = document.getElementById('state-not-platzi');
  const stateCourse = document.getElementById('state-course');
  const stateDownloading = document.getElementById('state-downloading');
  const courseTitle = document.getElementById('course-title');
  const classCount = document.getElementById('class-count');
  const classList = document.getElementById('class-list');
  const qualitySelect = document.getElementById('quality');
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnDownload = document.getElementById('btn-download');
  const btnCancel = document.getElementById('btn-cancel');
  const btnRetryFailed = document.getElementById('btn-retry-failed');
  const dlTitle = document.getElementById('dl-title');
  const dlClassName = document.getElementById('dl-class-name');
  const dlProgressBar = document.getElementById('dl-progress-bar');
  const dlProgressText = document.getElementById('dl-progress-text');
  const dlTotalBar = document.getElementById('dl-total-bar');
  const dlTotalText = document.getElementById('dl-total-text');
  const dlSize = document.getElementById('dl-size');
  const dlSpeed = document.getElementById('dl-speed');
  const downloadLog = document.getElementById('download-log');
  const classSearch = document.getElementById('class-search');

  let pageData = null;
  let activeTabId = null;
  let allSelected = false;

  // Event delegation para checkboxes (evita memory leak de listeners acumulativos)
  classList.addEventListener('change', () => {
    const checkboxes = classList.querySelectorAll('input[type="checkbox"]');
    const checked = classList.querySelectorAll('input[type="checkbox"]:checked');
    allSelected = checked.length === checkboxes.length;
    updateSelectAllButton();
    updateDownloadButton();
  });

  // Búsqueda de clases
  classSearch.addEventListener('input', () => {
    const query = classSearch.value.toLowerCase();
    const items = classList.querySelectorAll('.class-item');
    items.forEach((item) => {
      const title = item.querySelector('.class-title');
      const text = title ? title.textContent.toLowerCase() : '';
      item.style.display = text.includes(query) ? '' : 'none';
    });
  });

  // Event listeners de botones
  btnSelectAll.addEventListener('click', toggleSelectAll);
  btnDownload.addEventListener('click', startDownload);
  btnCancel.addEventListener('click', cancelDownload);
  btnRetryFailed.addEventListener('click', retryFailed);

  // Escuchar actualizaciones del background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'downloadStatus') {
      handleDownloadStatus(message);
    }
  });

  // =====================================================
  // Inicialización
  // =====================================================

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id;

    // Verificar si hay una descarga en curso (desde background)
    const status = await chrome.runtime
      .sendMessage({ action: 'getDownloadStatus' })
      .catch(() => null);

    if (status?.isDownloading) {
      showState('downloading');
      updateDownloadUI(status);

      // También verificar si estamos en Platzi para guardar pageData
      if (tab?.url?.includes('platzi.com/cursos/')) {
        try {
          pageData = await chrome.tabs.sendMessage(tab.id, { action: 'getPageData' });
        } catch {
          // No pasa nada, ya tenemos la descarga en curso
        }
      }
      return;
    }

    // Verificar sesión persistida (descarga recién terminada)
    const stored = await chrome.storage.session.get('downloadState').catch(() => ({}));
    if (stored.downloadState && !stored.downloadState.isDownloading && stored.downloadState.completedCount > 0) {
      // Mostrar resumen de última descarga completada
      showState('downloading');
      showCompletionSummary(stored.downloadState);

      // También intentar cargar datos del curso si estamos en Platzi
      if (tab?.url?.includes('platzi.com/cursos/')) {
        try {
          pageData = await chrome.tabs.sendMessage(tab.id, { action: 'getPageData' });
        } catch {
          // Ignorar
        }
      }
      return;
    }

    if (!tab?.url?.includes('platzi.com/cursos/')) {
      showState('not-platzi');
      return;
    }

    // Obtener datos de la página via content script
    try {
      pageData = await chrome.tabs.sendMessage(tab.id, { action: 'getPageData' });
    } catch {
      // Content script no disponible, inyectarlo manualmente
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await new Promise((r) => setTimeout(r, 500));
      pageData = await chrome.tabs.sendMessage(tab.id, { action: 'getPageData' }).catch(() => null);
    }

    if (!pageData || !pageData.classes?.length) {
      showState('not-platzi');
      return;
    }

    showCourse(pageData);
  } catch (error) {
    console.error('Error inicializando popup:', error);
    showState('not-platzi');
  }

  // =====================================================
  // Funciones de UI
  // =====================================================

  function showState(state) {
    stateNotPlatzi.classList.toggle('hidden', state !== 'not-platzi');
    stateCourse.classList.toggle('hidden', state !== 'course');
    stateDownloading.classList.toggle('hidden', state !== 'downloading');
  }

  function showCourse(data) {
    showState('course');
    courseTitle.textContent = data.courseTitle || data.courseSlug;
    classCount.textContent = `${data.classes.length} clases`;

    // Limpiar lista de clases (seguro, sin innerHTML)
    classList.replaceChildren();
    classSearch.value = '';

    // Renderizar lista de clases (sin innerHTML - previene XSS)
    data.classes.forEach((cls) => {
      const item = document.createElement('div');
      item.className = 'class-item';
      item.setAttribute('role', 'listitem');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.slug = cls.slug;
      checkbox.checked = true;
      checkbox.id = `class-${cls.slug}`;

      const numSpan = document.createElement('span');
      numSpan.className = 'class-number';
      numSpan.textContent = cls.number || '?';

      const label = document.createElement('label');
      label.className = 'class-title';
      label.setAttribute('for', `class-${cls.slug}`);
      label.title = cls.title;
      label.textContent = cls.title;

      item.appendChild(checkbox);
      item.appendChild(numSpan);
      item.appendChild(label);

      if (cls.duration) {
        const durSpan = document.createElement('span');
        durSpan.className = 'class-duration';
        durSpan.textContent = cls.duration;
        item.appendChild(durSpan);
      }

      classList.appendChild(item);
    });

    allSelected = true;
    updateSelectAllButton();
    updateDownloadButton();
  }

  function toggleSelectAll() {
    allSelected = !allSelected;
    const checkboxes = classList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      // Solo afectar clases visibles (respeta búsqueda)
      const item = cb.closest('.class-item');
      if (item && item.style.display !== 'none') {
        cb.checked = allSelected;
      }
    });
    updateSelectAllButton();
    updateDownloadButton();
  }

  function updateSelectAllButton() {
    btnSelectAll.textContent = allSelected ? 'Deseleccionar' : 'Seleccionar todo';
  }

  function updateDownloadButton() {
    const checked = classList.querySelectorAll('input[type="checkbox"]:checked');
    btnDownload.disabled = checked.length === 0;
    btnDownload.textContent =
      checked.length > 0 ? `Descargar (${checked.length})` : 'Descargar';
  }

  async function startDownload() {
    if (!pageData) return;

    const checked = classList.querySelectorAll('input[type="checkbox"]:checked');
    const selectedSlugs = new Set(Array.from(checked).map((cb) => cb.dataset.slug));

    const selectedClasses = pageData.classes.filter((cls) => selectedSlugs.has(cls.slug));

    if (selectedClasses.length === 0) return;

    const quality = qualitySelect.value;

    // Enviar al background con el tabId para executeScript
    await chrome.runtime.sendMessage({
      action: 'startDownload',
      classes: selectedClasses,
      courseSlug: pageData.courseSlug,
      courseTitle: pageData.courseTitle,
      quality,
      tabId: activeTabId,
    });

    showState('downloading');
    downloadLog.replaceChildren();
    btnRetryFailed.classList.add('hidden');
    btnCancel.textContent = 'Cancelar';
    btnCancel.className = 'btn btn-danger';
    dlSpeed.textContent = '';
    addLogEntry('info', `Iniciando descarga de ${selectedClasses.length} clases...`);
  }

  async function cancelDownload() {
    // Si es el botón "Cerrar" post-descarga, volver al curso
    if (btnCancel.textContent === 'Cerrar') {
      // Limpiar estado persistido
      await chrome.storage.session.remove('downloadState').catch(() => {});

      if (pageData) {
        showCourse(pageData);
      } else {
        showState('not-platzi');
      }
      return;
    }

    await chrome.runtime.sendMessage({ action: 'cancelDownload' });
    addLogEntry('error', 'Descarga cancelada');

    // Volver a mostrar el curso después de un momento
    setTimeout(() => {
      if (pageData) {
        showCourse(pageData);
      } else {
        showState('not-platzi');
      }
    }, 1500);
  }

  async function retryFailed() {
    const status = await chrome.runtime
      .sendMessage({ action: 'getDownloadStatus' })
      .catch(() => null);

    if (!status?.failedClasses?.length) return;

    await chrome.runtime.sendMessage({
      action: 'startDownload',
      classes: status.failedClasses,
      courseSlug: pageData?.courseSlug || status.courseTitle,
      courseTitle: status.courseTitle,
      quality: qualitySelect?.value || 'best',
      tabId: activeTabId,
    });

    btnRetryFailed.classList.add('hidden');
    downloadLog.replaceChildren();
    btnCancel.textContent = 'Cancelar';
    btnCancel.className = 'btn btn-danger';
    addLogEntry('info', `Reintentando ${status.failedClasses.length} clases fallidas...`);
  }

  function handleDownloadStatus(msg) {
    switch (msg.event) {
      case 'downloadStarted':
        dlTitle.textContent = 'Descargando...';
        dlTotalText.textContent = `0 / ${msg.total}`;
        dlSpeed.textContent = '';
        break;

      case 'classStarted':
        dlClassName.textContent = `${msg.classNumber}. ${msg.classTitle}`;
        dlProgressBar.style.width = '0%';
        dlProgressBar.parentElement.setAttribute('aria-valuenow', '0');
        dlProgressText.textContent = '0%';
        dlSpeed.textContent = '';
        addLogEntry('info', `Descargando: ${msg.classTitle}`);
        break;

      case 'downloadProgress': {
        const percent = msg.percent || 0;
        dlProgressBar.style.width = `${percent}%`;
        dlProgressBar.parentElement.setAttribute('aria-valuenow', String(percent));
        dlProgressText.textContent = `${percent}% (${msg.segmentIndex}/${msg.totalSegments})`;
        dlSize.textContent = formatBytes(msg.bytesDownloaded);

        // Mostrar velocidad y ETA
        const speed = formatSpeed(msg.speedBps);
        const eta = formatETA(msg.etaSeconds);
        dlSpeed.textContent = `${speed} \u00b7 ETA: ${eta}`;
        break;
      }

      case 'classCompleted':
        dlProgressBar.style.width = '100%';
        dlProgressBar.parentElement.setAttribute('aria-valuenow', '100');
        dlProgressText.textContent = '100%';
        dlTotalBar.style.width = `${(msg.completedCount / msg.totalCount) * 100}%`;
        dlTotalBar.parentElement.setAttribute(
          'aria-valuenow',
          String(Math.round((msg.completedCount / msg.totalCount) * 100))
        );
        dlTotalText.textContent = `${msg.completedCount} / ${msg.totalCount}`;
        dlSpeed.textContent = '';
        addLogEntry('success', msg.classTitle);
        break;

      case 'classError':
        addLogEntry('error', `${msg.classTitle}: ${msg.error}`);
        dlTotalBar.style.width = `${((msg.completedCount || 0) / (msg.totalCount || 1)) * 100}%`;
        dlTotalText.textContent = `${msg.completedCount || 0} / ${msg.totalCount || 0}`;
        dlSpeed.textContent = '';
        break;

      case 'downloadComplete':
        showCompletionSummary(msg);
        break;

      case 'downloadCancelled':
        dlTitle.textContent = 'Descarga cancelada';
        dlSpeed.textContent = '';
        break;
    }
  }

  function showCompletionSummary(data) {
    dlTitle.textContent = 'Descarga completada';
    dlClassName.textContent = `${data.completedCount} de ${data.totalCount} clases descargadas`;
    dlProgressBar.style.width = '100%';
    dlProgressBar.parentElement.setAttribute('aria-valuenow', '100');
    dlTotalBar.style.width = '100%';
    dlTotalBar.parentElement.setAttribute('aria-valuenow', '100');
    dlTotalText.textContent = `${data.completedCount} / ${data.totalCount}`;
    dlSpeed.textContent = '';

    if (data.failedClasses?.length > 0) {
      btnRetryFailed.classList.remove('hidden');
      addLogEntry('error', `${data.failedClasses.length} clase(s) fallaron`);
      data.failedClasses.forEach((fc) => {
        addLogEntry('error', `  \u2022 ${fc.title}: ${fc.error}`);
      });
    }

    addLogEntry('success', 'Descarga completada');

    if (data.courseTitle) {
      addLogEntry('info', `Archivos en: Descargas/Platzi/${data.courseTitle}/`);
    }

    // Cambiar botón "Cancelar" por "Cerrar"
    btnCancel.textContent = 'Cerrar';
    btnCancel.className = 'btn btn-secondary';
  }

  function updateDownloadUI(status) {
    if (status.current) {
      dlClassName.textContent = `${status.current.number}. ${status.current.title}`;
    }
    dlTotalText.textContent = `${status.completedCount} / ${status.totalCount}`;
    dlTotalBar.style.width = `${(status.completedCount / status.totalCount) * 100}%`;
  }

  // Construir entradas de log de forma segura (sin innerHTML - previene XSS)
  function addLogEntry(type, text) {
    const icons = { success: '\u2713', error: '\u2717', info: '\u2022' };

    const entry = document.createElement('div');
    entry.className = 'log-entry';

    const iconSpan = document.createElement('span');
    iconSpan.className = `log-icon ${type}`;
    iconSpan.textContent = icons[type] || '\u2022';

    const textSpan = document.createElement('span');
    textSpan.className = 'log-text';
    textSpan.textContent = text;

    entry.appendChild(iconSpan);
    entry.appendChild(textSpan);

    downloadLog.appendChild(entry);
    downloadLog.scrollTop = downloadLog.scrollHeight;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatSpeed(bps) {
    if (!bps || !isFinite(bps)) return '--';
    const mbps = bps / (1024 * 1024);
    if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
    return `${(bps / 1024).toFixed(0)} KB/s`;
  }

  function formatETA(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '--';
    if (seconds < 60) return `${seconds}s`;
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    if (min < 60) return `${min}m ${sec}s`;
    const hrs = Math.floor(min / 60);
    const remainMin = min % 60;
    return `${hrs}h ${remainMin}m`;
  }
});
