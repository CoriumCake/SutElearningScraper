
const $ = id => document.getElementById(id);

let scannedData = null;
let downloadsBasePath = null;
let sectionStatusCacheKey = '';
let sectionStatusCache = null;
let sectionStatusRunId = 0;
let sectionStatusPendingKey = '';


const DEFAULTS = {
  subfolder: 'SUT-eLearning',
  makeZip: false,
  showLog: false,
};
let settings = { ...DEFAULTS };

function invalidateSectionStatusCache() {
  sectionStatusCacheKey = '';
  sectionStatusCache = null;
  sectionStatusPendingKey = '';
}

async function loadSettings() {
  const s = await chrome.storage.local.get(['scraperSettings', 'downloadsBasePath']);
  if (s.scraperSettings)  settings = { ...DEFAULTS, ...s.scraperSettings };
  if (s.downloadsBasePath) downloadsBasePath = s.downloadsBasePath;
  applySettingsToUI();
  updateFolderPreview();
  updateFooter();
  updateLogVisibility();
}

async function saveSettings() {
  settings = {
    subfolder: $('setting-subfolder').value.trim() || 'SUT-eLearning',
    makeZip:   $('make-zip').checked,
    showLog:   $('show-log').checked,
  };
  await chrome.storage.local.set({ scraperSettings: settings });
  invalidateSectionStatusCache();
  updateFolderPreview();
  updateFooter();
  updateLogVisibility();
  $('save-confirm').textContent = '';
  closeSettings();
}

function applySettingsToUI() {
  $('setting-subfolder').value = settings.subfolder;
  $('make-zip').checked        = settings.makeZip;
  $('show-log').checked        = settings.showLog;
}

function updateLogVisibility() {
  const box = $('log-box');
  if (!box) return;
  box.style.display = settings.showLog && box.children.length ? 'block' : 'none';
}

function resetProgressUi() {
  $('progress-box').style.display = 'none';
  $('log-box').style.display = 'none';
  $('log-box').innerHTML = '';
  $('btn-row-main').style.display = 'flex';
  $('btn-row-running').style.display = 'none';
  $('progress-bar').style.width = '0%';
  $('progress-pct').textContent = '0%';
  $('progress-status').textContent = '';
  $('btn-download').disabled = !scannedData;
}


async function detectDownloadsPath() {
  if (downloadsBasePath) return;
  const cached = await chrome.storage.local.get('downloadsBasePath');
  if (cached.downloadsBasePath) { downloadsBasePath = cached.downloadsBasePath; return; }

  await new Promise(resolve => {
    chrome.downloads.search({ limit: 20, orderBy: ['-startTime'] }, (results) => {
      for (const dl of (results || [])) {
        if (!dl.filename) continue;
        const m = dl.filename.match(/^(.*?[/\\]Downloads)([/\\]|$)/i);
        if (m) {
          downloadsBasePath = m[1];
          chrome.storage.local.set({ downloadsBasePath });
          break;
        }
      }
      resolve();
    });
  });
}

function sep() { return downloadsBasePath?.includes('\\') ? '\\' : '/'; }

function fullPath(subfolder) {
  return downloadsBasePath ? `${downloadsBasePath}${sep()}${subfolder}` : subfolder;
}

function updateFolderPreview() {
  const sub = $('setting-subfolder').value.trim() || 'SUT-eLearning';
  const base = downloadsBasePath || 'Downloads';
  const s = base.includes('\\') ? '\\' : '/';
  $('folder-base-label').textContent = base + s;
}

function updateFooter() {
  $('footer-path').textContent = fullPath(settings.subfolder);
}

async function browseFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' });
    $('setting-subfolder').value = handle.name;
    updateFolderPreview();
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('Browse cancelled:', e);
  }
}


function buildFilename(courseName, sectionFolder, fileName) {
  const sub = settings.subfolder || 'SUT-eLearning';
  return `${sub}/${courseName}/${sectionFolder}/${fileName}`;
}


function sanitize(name) {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .substring(0, 80);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function filenameFromUrl(url) {
  try {
    const raw = url.split('?')[0].split('/').pop();
    return decodeURIComponent(raw).replace(/[/\\?%*:|"<>]/g, '-').trim();
  } catch { return ''; }
}

function guessExt(url, name) {
  const known = ['pdf','doc','docx','ppt','pptx','xls','xlsx','zip','rar','mp4','mp3','png','jpg','jpeg','gif','txt'];
  const urlExt = url.split('?')[0].split('.').pop().toLowerCase();
  if (known.includes(urlExt)) return '.' + urlExt;
  const nameExt = name.split('.').pop().toLowerCase();
  if (known.includes(nameExt)) return '';
  return '.pdf';
}

function normalizeRelativePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function downloadHistoryToRelativePath(absPath) {
  const normalized = String(absPath || '').replace(/\\/g, '/');
  const marker = '/Downloads/';
  const idx = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (idx >= 0) return normalized.slice(idx + marker.length);
  return normalized.split('/').slice(-3).join('/');
}

async function loadExistingDownloadPaths() {
  const paths = new Set();
  const items = await chrome.downloads.search({ state: 'complete' });
  items.forEach(item => {
    if (!item || !item.filename) return;
    if (item.exists === false) return;
    paths.add(normalizeRelativePath(downloadHistoryToRelativePath(item.filename)));
  });
  return paths;
}

function buildScanCacheKey(data, tabId) {
  const sectionsKey = (data.sections || []).map(sec => {
    const filesKey = (sec.files || []).map(file => [file.type || '', file.name || '', file.url || ''].join('|')).join('~');
    return `${sec.name || 'General'}:${filesKey}`;
  }).join('||');
  return [tabId, settings.subfolder || 'SUT-eLearning', data.courseName || 'Course', sectionsKey].join('::');
}

async function resolveSectionItems(tabId, courseName, section) {
  const sectionFolder = sanitize(section.name || 'General');
  const taskKeys = new Set();
  const pool = pPool(4);

  const results = await Promise.all((section.files || []).map(file =>
    pool(async () => {
      const taskKey = [sectionFolder, file.type || '', file.url || '', file.name || ''].join('::');
      if (taskKeys.has(taskKey)) return [];
      taskKeys.add(taskKey);
      try {
        return await resolveFile(tabId, file, courseName, sectionFolder);
      } catch (_) {
        return [];
      }
    })
  ));

  return results.flat().filter(item => item && !item._skip);
}

async function computeSectionStatuses(data, tabId) {
  const courseName = sanitize(data.courseName || 'Course');
  const existingPaths = await loadExistingDownloadPaths();

  return Promise.all((data.sections || []).map(async (section) => {
    const items = await resolveSectionItems(tabId, courseName, section);
    const totalItems = items.length;
    const existingItems = items.filter(item => existingPaths.has(normalizeRelativePath(item.filename))).length;
    return {
      totalItems,
      existingItems,
      isComplete: totalItems > 0 && existingItems === totalItems,
    };
  }));
}

function updateDownloadButtonAvailability() {
  const selectable = document.querySelector('.sec-check:not(:disabled):checked');
  $('btn-download').disabled = !scannedData || !selectable;
}



let scanInterval = null;

async function autoScan() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab) return;
  const url = tab.url || '';
  if (!/^https:\/\/elearning5?\.sut\.ac\.th\//.test(url) || !url.includes('/course/view.php')) return;

  let data;
  try {
    data = await chrome.tabs.sendMessage(tab.id, { action: 'SCAN' });
  } catch (_) { return; }
  if (!data?.sections) return;

  scannedData = data;
  renderScanResult(data, tab.id);
}

function startAutoScan() {
  if (scanInterval) return;
  autoScan();
  scanInterval = setInterval(autoScan, 1000);
}

function stopAutoScan() {
  if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
}

function renderScanResultRows(data, sectionStatuses = null) {
  const list = $('section-list');
  $('subject-name').textContent = data.courseName || 'Course';
  const prevChecked = {};
  list.querySelectorAll('.sec-check').forEach(cb => { prevChecked[cb.dataset.idx] = cb.checked; });

  list.innerHTML = '';
  let total = 0;
  data.sections.forEach((sec, i) => {
    const isTextOnly = sec.files.length === 1 && sec.files[0].type === 'text';
    const count = sec.files.length;
    const status = sectionStatuses?.[i] || null;
    const isComplete = !!status?.isComplete;
    const existingItems = status?.existingItems || 0;
    const totalItems = status?.totalItems || 0;
    let label = isTextOnly ? '.md' : `${count} file${count !== 1 ? 's' : ''}`;
    if (isComplete) label = 'Downloaded';
    else if (sectionStatuses && totalItems > 0 && existingItems > 0) label = `${existingItems}/${totalItems} downloaded`;

    const checked = isComplete ? false : (prevChecked[i] !== undefined ? prevChecked[i] : true);
    const disabled = isComplete ? 'disabled' : '';
    const row = document.createElement('div');
    row.className = `section-item${isComplete ? ' complete' : ''}`;
    row.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;flex:1;cursor:${isComplete ? 'default' : 'pointer'};min-width:0;overflow:hidden;">
        <input type="checkbox" class="sec-check" data-idx="${i}" ${checked ? 'checked' : ''} ${disabled}
               style="accent-color:#e07b39;flex-shrink:0;" />
        <span class="section-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(sec.name || 'General')}</span>
      </label>
      <span class="section-count${isComplete ? ' complete' : ''}" style="${isTextOnly && !isComplete ? 'background:#f0fff4;color:#276749' : ''}">${escapeHtml(label)}</span>`;
    list.appendChild(row);
    total += count;
  });
  $('total-files').textContent = total;
  $('total-sections').textContent = data.sections.length;
  $('scan-result').style.display = 'block';
  list.querySelectorAll('.sec-check').forEach(cb => cb.addEventListener('change', updateDownloadButtonAvailability));
  updateDownloadButtonAvailability();
}

function renderScanResult(data, tabId) {
  const runId = ++sectionStatusRunId;
  const cacheKey = buildScanCacheKey(data, tabId);
  const note = $('section-status-note');

  if (settings.makeZip) {
    renderScanResultRows(data, null);
    if (note) note.textContent = '';
    return;
  }

  renderScanResultRows(data, sectionStatusCacheKey === cacheKey ? sectionStatusCache : null);

  if (sectionStatusCacheKey === cacheKey && sectionStatusCache) {
    if (note) note.textContent = '';
    return;
  }

  if (sectionStatusPendingKey === cacheKey) {
    if (note) note.textContent = 'Checking downloaded files...';
    return;
  }

  sectionStatusPendingKey = cacheKey;
  if (note) note.textContent = 'Checking downloaded files...';

  computeSectionStatuses(data, tabId)
    .then((statuses) => {
      if (runId !== sectionStatusRunId || !statuses) return;

      sectionStatusCacheKey = cacheKey;
      sectionStatusCache = statuses;
      sectionStatusPendingKey = '';
      renderScanResultRows(data, statuses);
      if (note) note.textContent = '';
    })
    .catch(() => {
      if (runId !== sectionStatusRunId) return;
      sectionStatusPendingKey = '';
      if (note) note.textContent = '';
    });
}


function pPool(limit) {
  let active = 0;
  const queue = [];
  const run = async (fn, resolve, reject) => {
    active++;
    try { resolve(await fn()); } catch (e) { reject(e); } finally {
      active--;
      if (queue.length) { const [f, r, j] = queue.shift(); run(f, r, j); }
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    active < limit ? run(fn, resolve, reject) : queue.push([fn, resolve, reject]);
  });
}


async function resolveFile(tabId, file, courseName, sectionFolder) {
  if (file.type === 'text') {
    const fn = sanitize(file.name) + '.md';
    const dataUri = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(file.content);
    return [{ url: dataUri, filename: buildFilename(courseName, '_course-info', fn), name: fn }];
  }

  if (file.type === 'direct') {
    const urlFn = filenameFromUrl(file.url);
    const ext   = guessExt(file.url, file.name);
    const fn    = urlFn || (sanitize(file.name) + ext);
    return [{ url: file.url, filename: buildFilename(courseName, sectionFolder, fn), name: file.name }];
  }

  if (file.type === 'resource') {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'RESOLVE_RESOURCE', url: file.url });
    if (!r?.resolved) return [{ _skip: true, name: file.name, reason: 'Could not resolve' }];
    const urlFn = filenameFromUrl(r.resolved);
    const ext   = guessExt(r.resolved, file.name);
    const fn    = urlFn || (sanitize(file.name) + ext);
    return [{ url: r.resolved, filename: buildFilename(courseName, sectionFolder, fn), name: file.name }];
  }

  if (file.type === 'assign' || file.type === 'quiz') {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'RESOLVE_ASSIGNMENT', url: file.url });
    const atts = r?.files || [];
    if (atts.length === 0) return [{ _skip: true, name: file.name, reason: 'no attachments' }];
    return atts.map(att => {
      const urlFn = filenameFromUrl(att.url);
      const ext   = guessExt(att.url, att.name);
      const fn    = urlFn || (sanitize(att.name) + ext);
      return { url: att.url, filename: buildFilename(courseName, sectionFolder, sanitize(file.name) + ' - ' + fn), name: att.name };
    });
  }

  if (file.type === 'url') {
    const r = await chrome.tabs.sendMessage(tabId, { action: 'RESOLVE_URL_MODULE', url: file.url });
    const externalUrl = r?.resolved || file.url;
    const content  = `[InternetShortcut]\nURL=${externalUrl}\n`;
    const dataUri  = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
    const fn = sanitize(file.name) + '.url';
    return [{ url: dataUri, filename: buildFilename(courseName, sectionFolder, fn), name: file.name }];
  }

  return [];
}


const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const enc = new TextEncoder();
  const w16 = (a, o, v) => { a[o] = v & 0xFF; a[o+1] = (v >> 8) & 0xFF; };
  const w32 = (a, o, v) => { a[o] = v & 0xFF; a[o+1] = (v >> 8) & 0xFF; a[o+2] = (v >> 16) & 0xFF; a[o+3] = (v >>> 24) & 0xFF; };
  const cat  = (arrs) => { const out = new Uint8Array(arrs.reduce((s,a) => s+a.length,0)); let p=0; arrs.forEach(a=>{out.set(a,p);p+=a.length;}); return out; };

  const locals = [], central = [];
  let localOff = 0;

  for (const { name, data } of entries) {
    const nm = enc.encode(name);
    const crc = crc32(data), sz = data.length;

    const lh = new Uint8Array(30 + nm.length);
    w32(lh,0,0x04034B50); w16(lh,4,20); w16(lh,6,0x800); w16(lh,8,0);
    w16(lh,10,0); w16(lh,12,0); w32(lh,14,crc); w32(lh,18,sz); w32(lh,22,sz);
    w16(lh,26,nm.length); w16(lh,28,0); lh.set(nm,30);

    const ce = new Uint8Array(46 + nm.length);
    w32(ce,0,0x02014B50); w16(ce,4,20); w16(ce,6,20); w16(ce,8,0x800); w16(ce,10,0);
    w16(ce,12,0); w16(ce,14,0); w32(ce,16,crc); w32(ce,20,sz); w32(ce,24,sz);
    w16(ce,28,nm.length); w16(ce,30,0); w16(ce,32,0); w16(ce,34,0); w16(ce,36,0);
    w32(ce,38,0); w32(ce,42,localOff); ce.set(nm,46);

    locals.push(lh, data); central.push(ce);
    localOff += lh.length + sz;
  }

  const cd = cat(central);
  const eocd = new Uint8Array(22);
  w32(eocd,0,0x06054B50); w16(eocd,4,0); w16(eocd,6,0);
  w16(eocd,8,entries.length); w16(eocd,10,entries.length);
  w32(eocd,12,cd.length); w32(eocd,16,localOff); w16(eocd,20,0);

  return cat([...locals, cd, eocd]);
}

async function fetchFileBytes(url) {
  if (url.startsWith('data:')) {
    const b64 = url.split(',')[1];
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}


async function startDownload() {
  if (!scannedData) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  stopAutoScan();
  $('btn-row-main').style.display = 'none';
  $('btn-row-running').style.display = 'flex';
  $('progress-box').style.display = 'block';
  $('log-box').innerHTML = '';
  updateLogVisibility();

  const courseName = sanitize(scannedData.courseName || 'Course');
  const makeZip = settings.makeZip ?? false;

  const tasks = [];
  const taskKeys = new Set();
  for (let i = 0; i < scannedData.sections.length; i++) {
    const cb = document.querySelector(`.sec-check[data-idx="${i}"]`);
    if (cb && !cb.checked) continue;
    const section = scannedData.sections[i];
    const sectionFolder = sanitize(section.name || 'General');
    for (const file of section.files) {
      const taskKey = [sectionFolder, file.type || '', file.url || '', file.name || ''].join('::');
      if (taskKeys.has(taskKey)) continue;
      taskKeys.add(taskKey);
      tasks.push({ file, sectionFolder });
    }
  }

  const total = tasks.length;
  appendLog({ type: 'info', msg: `Handing ${total} items to background...` });
  renderProgress({ status: 'resolving', total, done: 0, skipped: 0, failed: 0, currentFile: 'Loading...', log: [] });

  if (total === 0) {
    appendLog({ type: 'err', msg: 'No downloadable files selected.' });
    renderProgress({ status: 'done', total: 0, done: 0, skipped: 0, failed: 0, currentFile: '', log: [] });
    return;
  }

  chrome.runtime.onMessage.addListener(onBgMessage);

  const resp = await chrome.runtime.sendMessage({
    action: 'START_DOWNLOAD',
    tabId: tab.id,
    tasks,
    courseName,
    subfolder: settings.subfolder,
    folder: fullPath(settings.subfolder),
    makeZip,
  });

  if (resp?.error) {
    chrome.runtime.onMessage.removeListener(onBgMessage);
    appendLog({ type: 'err', msg: resp.error });
  }
}


function appendLog(entry) {
  const box = $('log-box');
  const line = document.createElement('div');
  line.className = 'log-line' + (entry.type ? ' ' + entry.type : '');
  line.textContent = entry.msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  updateLogVisibility();
}

function renderLog(log) {
  const box = $('log-box');
  box.innerHTML = '';
  log.slice(-60).forEach(entry => {
    const line = document.createElement('div');
    line.className = 'log-line' + (entry.type ? ' ' + entry.type : '');
    line.textContent = entry.msg;
    box.appendChild(line);
  });
  box.scrollTop = box.scrollHeight;
  updateLogVisibility();
}


async function reconnectToBackground() {
  const stored = await chrome.storage.session.get('downloadState');
  const state = stored.downloadState;
  if (!state || state.status === 'idle') return;

  $('scan-result').style.display = scannedData ? 'block' : 'none';
  renderProgress(state);
  renderLog(state.log || []);

  if (state.status === 'running' || state.status === 'resolving') {
    chrome.runtime.onMessage.addListener(onBgMessage);
  }
}

function onBgMessage(msg) {
  if (msg.type !== 'STATE_UPDATE') return;
  const state = msg.state;
  if (state.status === 'idle') {
    resetProgressUi();
    chrome.runtime.onMessage.removeListener(onBgMessage);
    return;
  }
  renderProgress(state);

  const box = $('log-box');
  const existing = box.children.length;
  const newEntries = (state.log || []).slice(existing);
  newEntries.forEach(entry => appendLog(entry));

  if (state.status === 'done' || state.status === 'cancelled') {
    if (state.status === 'done') invalidateSectionStatusCache();
    chrome.runtime.onMessage.removeListener(onBgMessage);
  }
}


function openSettings() {
  $('main-header').style.display = 'none';
  $('settings-panel').classList.add('open');
  $('main-body').style.display = 'none';
  document.querySelector('.footer').style.display = 'none';
  updateFolderPreview();
}
function closeSettings() {
  $('main-header').style.display = 'flex';
  $('settings-panel').classList.remove('open');
  $('main-body').style.display = 'block';
  document.querySelector('.footer').style.display = 'block';
}
function renderProgress(state) {
  const { status, total, done, skipped = 0, failed, currentFile } = state;
  const finished = status === 'done' || status === 'cancelled';
  const pct = total > 0 ? Math.round((done + failed) / total * 100) : 0;

  const progressBox = $('progress-box');
  const progressBar = $('progress-bar');
  const progressPct = $('progress-pct');
  const progressTitle = $('progress-title');
  const progressStatus = $('progress-status');
  const btnRowMain = $('btn-row-main');
  const btnRowRunning = $('btn-row-running');
  const btnDownload = $('btn-download');

  if (!progressBox || !progressBar || !progressPct || !progressTitle || !progressStatus || !btnRowMain || !btnRowRunning || !btnDownload) return;

  progressBox.style.display = 'block';
  progressBar.style.width = pct + '%';
  progressPct.textContent = pct + '%';

  if (status === 'resolving') {
    progressTitle.textContent = 'Loading...';
    progressStatus.textContent = ''; 
  } else if (status === 'running') {
    progressTitle.textContent = `Downloading (${done + failed}/${total})`;
    progressStatus.textContent = currentFile ? `Downloading ${currentFile}` : '';
  } else if (finished) {
    progressTitle.textContent = status === 'cancelled' ? 'Cancelled' : 'Done';
    progressStatus.textContent = `${done} saved, ${skipped} skipped, ${failed} failed`;
  }

  btnRowMain.style.display = finished ? 'flex' : 'none';
  btnRowRunning.style.display = finished ? 'none' : 'flex';
  if (finished) {
    btnDownload.disabled = false;
    startAutoScan();
  }
}


document.addEventListener('DOMContentLoaded', async () => {
  await detectDownloadsPath();
  await loadSettings();
  await reconnectToBackground();

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-back').addEventListener('click', closeSettings);
  $('btn-save-settings').addEventListener('click', saveSettings);
  $('btn-browse').addEventListener('click', browseFolder);
  $('setting-subfolder').addEventListener('input', updateFolderPreview);

  $('btn-download').addEventListener('click', startDownload);
  startAutoScan();

  $('btn-cancel').addEventListener('click', async () => {
    const resp = await chrome.runtime.sendMessage({ action: 'CANCEL' });
    if (resp?.ok) {
      resetProgressUi();
      startAutoScan();
    }
  });
});




