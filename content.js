// Content script - se inyecta en páginas de Platzi
// Extrae información del curso y las clases del DOM

(function () {
  'use strict';

  function extractCourseSlug() {
    const match = window.location.pathname.match(/\/cursos\/([^/]+)\//);
    return match ? match[1] : null;
  }

  function extractCurrentClassSlug() {
    const match = window.location.pathname.match(/\/cursos\/[^/]+\/([^/]+)/);
    return match ? match[1] : null;
  }

  function extractVideoM3u8Url() {
    const pattern = /https:\/\/api\.platzi\.com\/mdstrm\/v1\/video\/([a-f0-9]+)\.m3u8/;

    // Estrategia 1: Buscar en <script> tags (más eficiente que innerHTML)
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      if (script.textContent) {
        const match = script.textContent.match(pattern);
        if (match) return { url: match[0], videoId: match[1] };
      }
    }

    // Estrategia 2: Buscar en elementos de video
    const videoEls = document.querySelectorAll(
      'video source[src*="mdstrm"], video[src*="mdstrm"], [data-src*="mdstrm"]'
    );
    for (const el of videoEls) {
      const src = el.getAttribute('src') || el.getAttribute('data-src');
      if (src) {
        const match = src.match(pattern);
        if (match) return { url: match[0], videoId: match[1] };
      }
    }

    // Estrategia 3: Fallback a innerHTML (lento pero exhaustivo)
    try {
      const html = document.documentElement.innerHTML;
      const match = html.match(pattern);
      return match ? { url: match[0], videoId: match[1] } : null;
    } catch {
      return null;
    }
  }

  function extractCourseTitle() {
    // Intentar desde el header de la página
    const headerEl = document.querySelector('h1[class*="CourseHeader"], [class*="CourseDetail"] h1');
    if (headerEl) return headerEl.textContent.trim();

    // Desde el breadcrumb en la barra superior
    const breadcrumb = document.querySelector('[class*="Breadcrumb"]');
    if (breadcrumb) return breadcrumb.textContent.trim();

    // Desde el texto "Clase X de Y · Curso para ser CEO"
    const topBar = document.querySelector('[class*="MaterialHeader"], header');
    if (topBar) {
      const text = topBar.textContent;
      const match = text.match(/·\s*(.+)/);
      if (match) return match[1].trim();
    }

    return extractCourseSlug() || 'curso-desconocido';
  }

  function extractClasses() {
    const classes = [];
    const courseSlug = extractCourseSlug();
    if (!courseSlug) return classes;

    // Buscar links de clases en el Syllabus sidebar
    const syllabusLinks = document.querySelectorAll(
      `a[class*="ItemLink"][href*="/cursos/${courseSlug}/"]`
    );

    if (syllabusLinks.length === 0) {
      // Fallback: buscar todos los links al curso
      const allLinks = document.querySelectorAll(`a[href*="/cursos/${courseSlug}/"]`);
      allLinks.forEach(processLink);
    } else {
      syllabusLinks.forEach(processLink);
    }

    function processLink(a) {
      const href = a.getAttribute('href');
      // Guard: href puede ser null o vacío
      if (!href || !href.includes(`/cursos/${courseSlug}/`)) return;

      const slug = href.replace(`/cursos/${courseSlug}/`, '').replace(/\/$/, '');

      // Ignorar links que no son clases
      if (!slug || slug.includes('?') || slug.includes('#')) return;

      const text = (a.textContent || '').trim();

      // Ignorar navegación
      if (text === 'Siguiente clase' || text === 'Clase anterior') return;

      // Extraer número
      const numMatch = text.match(/^(\d+)/);
      const number = numMatch ? parseInt(numMatch[1]) : null;

      // Extraer duración
      const durMatch = text.match(/(\d+:\d+)\s*min/);
      const duration = durMatch ? durMatch[1] : null;

      // Extraer título limpio
      let title = text
        .replace(/^\d+/, '')
        .replace(/\d+:\d+\s*min$/, '')
        .replace(/Viendo ahora$/, '')
        .replace(/Completado$/, '')
        .trim();

      // Evitar duplicados
      if (classes.some((c) => c.slug === slug)) return;

      classes.push({
        number,
        slug,
        title: title || slug,
        duration,
        href: `/cursos/${courseSlug}/${slug}/`,
        fullUrl: `https://platzi.com/cursos/${courseSlug}/${slug}/`,
      });
    }

    // Ordenar por número de clase
    classes.sort((a, b) => (a.number || 0) - (b.number || 0));
    return classes;
  }

  function extractSections() {
    const sections = [];
    const syllabus = document.querySelector('[class*="Syllabus"]');
    if (!syllabus) return sections;

    const articles = syllabus.querySelectorAll('article');
    articles.forEach((article) => {
      const header = article.querySelector('h3, h2, [class*="Title"]');
      sections.push({
        title: header ? header.textContent.trim() : 'Sin título',
      });
    });
    return sections;
  }

  function extractResume() {
    // Extraer el texto del resumen de la clase
    const resumeHeader = Array.from(document.querySelectorAll('h2, h3, strong')).find(
      (el) => (el.textContent || '').trim() === 'Resumen'
    );

    if (!resumeHeader) return null;

    // Obtener todo el contenido después del header "Resumen"
    let content = '';
    let el = resumeHeader.closest('div') || resumeHeader.parentElement;
    if (el) {
      content = el.textContent || '';
    }
    return content || null;
  }

  function gatherPageData() {
    const courseSlug = extractCourseSlug();
    const currentClassSlug = extractCurrentClassSlug();
    const video = extractVideoM3u8Url();
    const classes = extractClasses();
    const courseTitle = extractCourseTitle();
    const resume = extractResume();
    const sections = extractSections();

    return {
      courseSlug,
      courseTitle,
      currentClassSlug,
      video,
      classes,
      sections,
      resume,
      url: window.location.href,
    };
  }

  // Escuchar mensajes del popup o background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getPageData') {
      const data = gatherPageData();
      sendResponse(data);
      return true;
    }

    if (message.action === 'extractVideoFromPage') {
      const video = extractVideoM3u8Url();
      const resume = extractResume();
      sendResponse({ video, resume });
      return true;
    }
  });

  // Notificar al background que la página cargó
  const pageData = gatherPageData();
  chrome.runtime.sendMessage({
    action: 'pageLoaded',
    data: pageData,
  });
})();
