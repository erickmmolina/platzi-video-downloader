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
  const dlTitle = document.getElementById('dl-title');
  const dlClassName = document.getElementById('dl-class-name');
  const dlProgressBar = document.getElementById('dl-progress-bar');
  const dlProgressText = document.getElementById('dl-progress-text');
  const dlTotalBar = document.getElementById('dl-total-bar');
  const dlTotalText = document.getElementById('dl-total-text');
  const dlSize = document.getElementById('dl-size');
  const downloadLog = document.getElementById('download-log');

  let pageData = null;
  let activeTabId = null;
  let allSelected = false;

  // Verificar si estamos en una página de Platzi
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab?.id;

    if (!tab?.url?.includes('platzi.com/cursos/')) {
      showState('not-platzi');

      // Verificar si hay una descarga en curso
      const status = await chrome.runtime.sendMessage({ action: 'getDownloadStatus' }).catch(() => null);
      if (status?.isDownloading) {
        showState('downloading');
      }
      return;
    }

    // Obtener datos de la página via content script
    // Puede fallar si el content script aún no cargó, reintentamos con executeScript
    try {
      pageData = await chrome.tabs.sendMessage(tab.id, { action: 'getPageData' });
    } catch {
      // Content script no disponible, inyectarlo manualmente
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      // Esperar un momento para que se inicialice
      await new Promise((r) => setTimeout(r, 500));
      pageData = await chrome.tabs.sendMessage(tab.id, { action: 'getPageData' }).catch(() => null);
    }

    if (!pageData || !pageData.classes?.length) {
      showState('not-platzi');
      return;
    }

    // Verificar si hay una descarga en curso
    const status = await chrome.runtime.sendMessage({ action: 'getDownloadStatus' }).catch(() => null);
    if (status?.isDownloading) {
      showState('downloading');
      updateDownloadUI(status);
      return;
    }

    // Mostrar datos del curso
    showCourse(pageData);
  } catch (error) {
    console.error('Error inicializando popup:', error);
    showState('not-platzi');
  }

  // Event listeners
  btnSelectAll.addEventListener('click', toggleSelectAll);
  btnDownload.addEventListener('click', startDownload);
  btnCancel.addEventListener('click', cancelDownload);

  // Escuchar actualizaciones del background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'downloadStatus') {
      handleDownloadStatus(message);
    }
  });

  function showState(state) {
    stateNotPlatzi.classList.toggle('hidden', state !== 'not-platzi');
    stateCourse.classList.toggle('hidden', state !== 'course');
    stateDownloading.classList.toggle('hidden', state !== 'downloading');
  }

  function showCourse(data) {
    showState('course');
    courseTitle.textContent = data.courseTitle || data.courseSlug;
    classCount.textContent = `${data.classes.length} clases`;

    // Renderizar lista de clases
    classList.innerHTML = '';
    data.classes.forEach((cls) => {
      const item = document.createElement('div');
      item.className = 'class-item';
      item.innerHTML = `
        <input type="checkbox" data-slug="${cls.slug}" checked>
        <span class="class-number">${cls.number || '?'}</span>
        <span class="class-title" title="${cls.title}">${cls.title}</span>
        ${cls.duration ? `<span class="class-duration">${cls.duration}</span>` : ''}
      `;
      classList.appendChild(item);
    });

    allSelected = true;
    updateSelectAllButton();
    updateDownloadButton();

    // Listener para checkboxes
    classList.addEventListener('change', () => {
      const checkboxes = classList.querySelectorAll('input[type="checkbox"]');
      const checked = classList.querySelectorAll('input[type="checkbox"]:checked');
      allSelected = checked.length === checkboxes.length;
      updateSelectAllButton();
      updateDownloadButton();
    });
  }

  function toggleSelectAll() {
    allSelected = !allSelected;
    const checkboxes = classList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => (cb.checked = allSelected));
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
    downloadLog.innerHTML = '';
    addLogEntry('info', `Iniciando descarga de ${selectedClasses.length} clases...`);
  }

  async function cancelDownload() {
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

  function handleDownloadStatus(msg) {
    switch (msg.event) {
      case 'downloadStarted':
        dlTitle.textContent = 'Descargando...';
        dlTotalText.textContent = `0 / ${msg.total}`;
        break;

      case 'classStarted':
        dlClassName.textContent = `${msg.classNumber}. ${msg.classTitle}`;
        dlProgressBar.style.width = '0%';
        dlProgressText.textContent = '0%';
        addLogEntry('info', `Descargando: ${msg.classTitle}`);
        break;

      case 'downloadProgress':
        dlProgressBar.style.width = `${msg.percent}%`;
        dlProgressText.textContent = `${msg.percent}% (${msg.segmentIndex}/${msg.totalSegments})`;
        dlSize.textContent = formatBytes(msg.bytesDownloaded);
        break;

      case 'classCompleted':
        dlProgressBar.style.width = '100%';
        dlProgressText.textContent = '100%';
        dlTotalBar.style.width = `${(msg.completedCount / msg.totalCount) * 100}%`;
        dlTotalText.textContent = `${msg.completedCount} / ${msg.totalCount}`;
        addLogEntry('success', `${msg.classTitle}`);
        break;

      case 'classError':
        addLogEntry('error', `${msg.classTitle}: ${msg.error}`);
        dlTotalBar.style.width = `${(msg.completedCount / msg.totalCount) * 100}%`;
        dlTotalText.textContent = `${msg.completedCount} / ${msg.totalCount}`;
        break;

      case 'downloadComplete':
        dlTitle.textContent = 'Descarga completada';
        dlClassName.textContent = `${msg.completedCount} de ${msg.totalCount} clases descargadas`;
        dlProgressBar.style.width = '100%';
        dlTotalBar.style.width = '100%';
        addLogEntry('success', 'Descarga completada');
        break;

      case 'downloadCancelled':
        dlTitle.textContent = 'Descarga cancelada';
        break;
    }
  }

  function updateDownloadUI(status) {
    if (status.current) {
      dlClassName.textContent = `${status.current.number}. ${status.current.title}`;
    }
    dlTotalText.textContent = `${status.completedCount} / ${status.totalCount}`;
    dlTotalBar.style.width = `${(status.completedCount / status.totalCount) * 100}%`;
  }

  function addLogEntry(type, text) {
    const icons = { success: '\u2713', error: '\u2717', info: '\u2022' };
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
      <span class="log-icon ${type}">${icons[type]}</span>
      <span class="log-text">${text}</span>
    `;
    downloadLog.appendChild(entry);
    downloadLog.scrollTop = downloadLog.scrollHeight;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
});
