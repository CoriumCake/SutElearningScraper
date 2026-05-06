(function () {
  const resourceResolveCache = new Map();
  const urlResolveCache = new Map();
  const assignmentResolveCache = new Map();

  function sanitize(name) {
    return name
      .replace(/[/\\?%*:|"<>]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 80);
  }

  function abs(href) {
    if (!href) return null;
    if (href.startsWith('http')) return href;
    return new URL(href, window.location.origin).href;
  }

  function isDownloadable(url) {
    if (!url) return false;
    const downloadParams = ['forcedownload=1', 'mod/resource', 'pluginfile.php'];
    return downloadParams.some(p => url.includes(p));
  }

  function getCourseName() {
    const h1 = document.querySelector('h1.page-header-headings span, h1.h2, .page-header-headings h1');
    if (h1) return sanitize(h1.textContent.trim());
    const title = document.title.replace(/[|-].*$/, '').trim();
    return sanitize(title) || 'Course';
  }

  function htmlToMarkdown(el) {
    function walk(node, ctx) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent;
        return ctx.inline ? t : t;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      const inner = () => [...node.childNodes].map(c => walk(c, ctx)).join('');

      if (node.matches?.('.editing_title, .actions, .activity, .modtype_assign, .modtype_quiz, nav, button, input, select, .icon, .iconleft')) return '';

      switch (tag) {
        case 'h1': return `\n# ${node.textContent.trim()}\n\n`;
        case 'h2': return `\n## ${node.textContent.trim()}\n\n`;
        case 'h3': return `\n### ${node.textContent.trim()}\n\n`;
        case 'h4': return `\n#### ${node.textContent.trim()}\n\n`;
        case 'h5': case 'h6': return `\n##### ${node.textContent.trim()}\n\n`;
        case 'p': {
          const t = inner().trim();
          return t ? `\n${t}\n` : '';
        }
        case 'br': return '\n';
        case 'hr': return '\n---\n';
        case 'strong': case 'b': return `**${node.textContent.trim()}**`;
        case 'em': case 'i': return `*${node.textContent.trim()}*`;
        case 'code': return '`' + node.textContent + '`';
        case 'a': {
          const href = node.getAttribute('href');
          const text = node.textContent.trim();
          if (!text) return '';
          return href && !href.startsWith('#') ? `[${text}](${abs(href)})` : text;
        }
        case 'ul': {
          const items = [...node.querySelectorAll(':scope > li')]
            .map(li => `- ${li.textContent.trim()}`)
            .join('\n');
          return items ? `\n${items}\n` : '';
        }
        case 'ol': {
          const items = [...node.querySelectorAll(':scope > li')]
            .map((li, i) => `${i + 1}. ${li.textContent.trim()}`)
            .join('\n');
          return items ? `\n${items}\n` : '';
        }
        case 'li': return `- ${node.textContent.trim()}\n`;
        case 'table': {
          const rows = [...node.querySelectorAll('tr')];
          if (!rows.length) return '';
          const lines = rows.map(tr => {
            const cells = [...tr.querySelectorAll('td,th')].map(c => c.textContent.trim());
            return `| ${cells.join(' | ')} |`;
          });
          if (rows[0].querySelector('th')) {
            const cols = rows[0].querySelectorAll('th').length;
            lines.splice(1, 0, '|' + ' --- |'.repeat(cols));
          }
          return `\n${lines.join('\n')}\n`;
        }
        case 'thead': case 'tbody': case 'tfoot': return inner();
        case 'tr': return inner();
        case 'td': case 'th': return inner();
        case 'script': case 'style': case 'svg': case 'img': return '';
        default: return inner();
      }
    }
    const raw = walk(el, {});
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }

  function extractSectionContent(secEl, sectionName) {
    const clone = secEl.cloneNode(true);

    clone.querySelectorAll([
      '.sectionname', '.section-title', 'h3.sectionname',
      '.activity', '.modtype_assign', '.modtype_quiz',
      '.editing_title', '.section_availability', '.sectionaddmenus',
      '.controls', '.actions', 'button', 'form',
      '.course-section-header',   // Moodle 4 section header with toggle
      '[data-for="sectiontitle"]',
    ].join(', ')).forEach(el => el.remove());

    const md = htmlToMarkdown(clone);
    if (!md || md.trim().length < 15) return null;

    return `# ${sectionName}\n\n${md.trim()}\n`;
  }

  function scrapeFromCourseIndex() {
    const container = document.querySelector(
      '#courseindex, [data-region="course-index"], .courseindex, .course-index'
    );
    if (!container) return [];

    const sections = [];

    const secEls = container.querySelectorAll(
      'li.courseindex-section, [data-for="courseindex-section"], .courseindex-section'
    );

    secEls.forEach(secEl => {
      const titleEl = secEl.querySelector(
        '.courseindex-section-title, [data-for="sectionname"], .section-title'
      );
      const sectionName = sanitize(titleEl?.textContent?.trim() || 'General');
      const files = [];
      const seen = new Set();

      secEl.querySelectorAll('a[href]').forEach(a => {
        const href = abs(a.getAttribute('href'));
        if (!href || seen.has(href)) return;
        seen.add(href);

        const nameEl = a.querySelector('.courseindex-name, [data-activityname]');
        const text = sanitize(nameEl?.textContent?.trim() || a.textContent.trim() || 'file');

        if (href.includes('/mod/resource/view.php'))
          files.push({ url: href, name: text, type: 'resource' });
        else if (href.includes('/mod/assign/view.php'))
          files.push({ url: href, name: text, type: 'assign' });
        else if (href.includes('/mod/quiz/view.php'))
          files.push({ url: href, name: text, type: 'quiz' });
        else if (href.includes('/mod/url/view.php'))
          files.push({ url: href, name: text, type: 'url' });
        else if (href.includes('pluginfile.php') || href.includes('forcedownload=1'))
          files.push({ url: href, name: text, type: 'direct' });
      });

      if (files.length > 0) sections.push({ name: sectionName, files });
    });

    return sections;
  }

  function scrapeCourse() {
    const courseName = getCourseName();
    const sections = [];

    const sectionEls = document.querySelectorAll(
      'li.section.main, li[id^="section-"], div.course-section, div[data-sectionid]'
    );

    sectionEls.forEach((secEl) => {
      let sectionName = 'General';
      const titleEl = secEl.querySelector(
        '.sectionname, .section-title, h3.sectionname, .content > h3, [class*="section-name"]'
      );
      if (titleEl) sectionName = sanitize(titleEl.textContent.trim());

      const files = [];
      const seenUrls = new Set();

      secEl.querySelectorAll('a[href]').forEach((a) => {
        const href = abs(a.getAttribute('href'));
        if (!href || seenUrls.has(href)) return;
        seenUrls.add(href);

        const text = a.textContent.trim() || a.title || 'file';

        if (href.includes('/mod/resource/view.php') || href.includes('/mod/folder/view.php')) {
          files.push({ url: href, name: sanitize(text), type: 'resource' });
          return;
        }

        if (href.includes('/mod/assign/view.php')) {
          files.push({ url: href, name: sanitize(text), type: 'assign' });
          return;
        }

        if (href.includes('/mod/quiz/view.php')) {
          files.push({ url: href, name: sanitize(text), type: 'quiz' });
          return;
        }

        if (href.includes('pluginfile.php') || href.includes('forcedownload=1')) {
          const ext = href.split('?')[0].split('.').pop().toLowerCase();
          files.push({ url: href, name: sanitize(text) + (text.includes('.') ? '' : '.' + ext), type: 'direct' });
          return;
        }

        if (href.includes('/mod/url/view.php')) {
          files.push({ url: href, name: sanitize(text), type: 'url' });
        }
      });

      secEl.querySelectorAll('img[src*="pdf"], .activityicon[src*="pdf"]').forEach((img) => {
        const parent = img.closest('a[href]');
        if (parent) {
          const href = abs(parent.getAttribute('href'));
          const text = parent.textContent.trim() || 'document';
          if (href && !files.some(f => f.url === href)) {
            files.push({ url: href, name: sanitize(text), type: 'resource' });
          }
        }
      });

      if (files.length > 0) {
        sections.push({ name: sectionName, files });
      }
    });

    if (sections.length === 0 || sections.every(s => s.files.length === 0)) {
      const fallbackFiles = [];
      const seenFallbackUrls = new Set();
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = abs(a.getAttribute('href'));
        if (!href || seenFallbackUrls.has(href)) return;
        if (
          href.includes('/mod/resource/view.php') ||
          href.includes('pluginfile.php') ||
          href.includes('/mod/url/view.php') ||
          href.includes('forcedownload=1')
        ) {
          seenFallbackUrls.add(href);
          const text = a.textContent.trim() || 'file';
          fallbackFiles.push({ url: href, name: sanitize(text), type: 'resource' });
        }
      });
      if (fallbackFiles.length > 0) {
        sections.push({ name: 'Materials', files: fallbackFiles });
      }
    }

    const capturedUrls = new Set(sections.flatMap(s => s.files.map(f => f.url)));

    const activityEls = document.querySelectorAll([
      'li[class*="modtype_assign"]',
      'li[class*="modtype_quiz"]',
      'div[class*="modtype_assign"]',
      'div[class*="modtype_quiz"]',
      'li[data-activitytype="assign"]',
      'li[data-activitytype="quiz"]',
    ].join(', '));

    activityEls.forEach((actEl) => {
      if (actEl.closest('#nav-drawer, .drawer, [data-region="drawer"]')) return;

      const cls = actEl.className || '';
      const dataType = actEl.dataset?.activitytype || '';
      const type = (cls.includes('modtype_assign') || dataType === 'assign') ? 'assign' : 'quiz';

      const link = actEl.querySelector(
        'a.aalink, a[href*="/mod/assign/"], a[href*="/mod/quiz/"], a.activitylink'
      );
      if (!link) return;

      const href = abs(link.getAttribute('href'));
      if (!href || capturedUrls.has(href)) return;

      const nameEl = actEl.querySelector('.instancename, .activityname span:first-child, .mod-indent-outer .aalink');
      const rawName = (nameEl?.childNodes[0]?.textContent || nameEl?.textContent || link.textContent || 'Assignment').trim();
      const name = sanitize(rawName);

      let sectionName = 'Quizzes and Assignments';
      let el = actEl.parentElement;
      while (el && el !== document.body) {
        if (el.matches('li.section.main, li[id^="section-"], div.course-section, div[data-sectionid], [data-for="section"]')) {
          const t = el.querySelector('.sectionname, .section-title, h3.sectionname, [class*="section-name"]');
          if (t) sectionName = sanitize(t.textContent.trim());
          break;
        }
        el = el.parentElement;
      }

      let sec = sections.find(s => s.name === sectionName);
      if (!sec) {
        sec = { name: sectionName, files: [] };
        sections.push(sec);
      }
      sec.files.push({ url: href, name, type });
      capturedUrls.add(href);
    });

    const indexSections = scrapeFromCourseIndex();
    const capturedUrlsAll = new Set(sections.flatMap(s => s.files.map(f => f.url)));
    for (const idxSec of indexSections) {
      const newFiles = idxSec.files.filter(f => !capturedUrlsAll.has(f.url));
      if (newFiles.length === 0) continue;
      newFiles.forEach(f => capturedUrlsAll.add(f.url));
      const existing = sections.find(s => s.name === idxSec.name);
      if (existing) existing.files.push(...newFiles);
      else sections.push({ name: idxSec.name, files: newFiles });
    }

    return { courseName, sections, pageUrl: window.location.href };
  }

  async function resolveResourceUrl(resourcePageUrl) {
    if (resourceResolveCache.has(resourcePageUrl)) {
      return resourceResolveCache.get(resourcePageUrl);
    }

    const pending = (async () => {
    try {
      const resp = await fetch(resourcePageUrl, { credentials: 'include', redirect: 'follow' });
      const finalUrl = resp.url;

      if (finalUrl !== resourcePageUrl) {
        if (
          finalUrl.includes('pluginfile.php') ||
          finalUrl.match(/\.(pdf|docx?|pptx?|xlsx?|zip|rar|mp4|mp3|png|jpg|jpeg|gif|txt)(\?|$)/i)
        ) {
          return finalUrl;
        }
      }

      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const selectors = [
        'a[href*="pluginfile.php"]',
        'a[href*="forcedownload=1"]',
        'object[data*="pluginfile.php"]',
        'embed[src*="pluginfile.php"]',
        '.resourceworkaround a',
        '.resourcecontent a',
        'a.aalink[href*="pluginfile"]',
        '.box.generalbox a[href*="pluginfile"]',
        'div.resourcecontent a',
      ];

      for (const sel of selectors) {
        const el = doc.querySelector(sel);
        if (el) {
          const url = el.getAttribute('href') || el.getAttribute('data') || el.getAttribute('src');
          if (url) return url.startsWith('http') ? url : new URL(url, window.location.origin).href;
        }
      }

      const iframe = doc.querySelector('iframe[src*="pluginfile"], iframe[src*="forcedownload"]');
      if (iframe) {
        const src = iframe.getAttribute('src');
        return src.startsWith('http') ? src : new URL(src, window.location.origin).href;
      }

      const anyFileLink = doc.querySelector('a[href*=".pdf"], a[href*=".pptx"], a[href*=".docx"], a[href*=".zip"]');
      if (anyFileLink) {
        const url = anyFileLink.getAttribute('href');
        return url.startsWith('http') ? url : new URL(url, window.location.origin).href;
      }

      return null;
    } catch (e) {
      return null;
    }
    })();

    resourceResolveCache.set(resourcePageUrl, pending);
    return pending;
  }

  async function resolveUrlModule(urlPageUrl) {
    if (urlResolveCache.has(urlPageUrl)) {
      return urlResolveCache.get(urlPageUrl);
    }

    const pending = (async () => {
    try {
      const resp = await fetch(urlPageUrl, { credentials: 'include', redirect: 'follow' });
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const link = doc.querySelector('.urlworkaround a, .box.generalbox a, .resourcecontent a');
      if (link) return link.getAttribute('href');
      return null;
    } catch (e) {
      return null;
    }
    })();

    urlResolveCache.set(urlPageUrl, pending);
    return pending;
  }

  async function resolveAssignmentFiles(pageUrl) {
    if (assignmentResolveCache.has(pageUrl)) {
      return assignmentResolveCache.get(pageUrl);
    }

    const pending = (async () => {
    try {
      const resp = await fetch(pageUrl, { credentials: 'include', redirect: 'follow' });
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const results = [];
      const seenAttachmentUrls = new Set();

      const introSelectors = [
        '.assignmentdescription',
        '.fintro',                    // mod_assign intro
        '.box.generalbox.boxaligncenter',
        '.intro',
        '#intro',
        'div[id$="-intro"]',
        '.summary',
      ];

      let introEl = null;
      for (const sel of introSelectors) {
        introEl = doc.querySelector(sel);
        if (introEl) break;
      }

      const searchRoot = introEl || doc;

      searchRoot.querySelectorAll('a[href*="pluginfile.php"], a[href*="forcedownload=1"]').forEach((a) => {
        const href = a.getAttribute('href');
        if (!href) return;
        const fullUrl = href.startsWith('http') ? href : new URL(href, window.location.origin).href;
        if (seenAttachmentUrls.has(fullUrl)) return;
        seenAttachmentUrls.add(fullUrl);
        const name = a.textContent.trim() || a.getAttribute('title') || 'attachment';
        results.push({ url: fullUrl, name: sanitize(name) });
      });

      searchRoot.querySelectorAll('.fp-filename-icon a, .filemanager a').forEach((a) => {
        const href = a.getAttribute('href');
        if (!href) return;
        const fullUrl = href.startsWith('http') ? href : new URL(href, window.location.origin).href;
        if (seenAttachmentUrls.has(fullUrl)) return;
        seenAttachmentUrls.add(fullUrl);
        const name = a.textContent.trim() || 'attachment';
        results.push({ url: fullUrl, name: sanitize(name) });
      });

      return results;
    } catch (e) {
      return [];
    }
    })();

    assignmentResolveCache.set(pageUrl, pending);
    return pending;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'SCAN') {
      const result = scrapeCourse();
      sendResponse(result);
      return true;
    }

    if (msg.action === 'RESOLVE_RESOURCE') {
      resolveResourceUrl(msg.url).then(resolved => {
        sendResponse({ resolved });
      });
      return true;
    }

    if (msg.action === 'RESOLVE_ASSIGNMENT') {
      resolveAssignmentFiles(msg.url).then(files => {
        sendResponse({ files });
      });
      return true;
    }

    if (msg.action === 'RESOLVE_URL_MODULE') {
      resolveUrlModule(msg.url).then(resolved => {
        sendResponse({ resolved });
      });
      return true;
    }
  });
})();
