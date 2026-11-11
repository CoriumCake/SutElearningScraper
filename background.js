const EMPTY_STATE = {
  status: 'idle',
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  currentFile: '',
  log: [],
  startedAt: null,
  finishedAt: null,
};

const RESOLVE_CONCURRENCY = 6;
const DOWNLOAD_CONCURRENCY = 5;

let state = { ...EMPTY_STATE };
let isRunning = false;
let currentRunId = 0;
let cancelPromise = null;

let startedDownloadIds = new Set();
let activeDownloadIds = new Set();
let completedDownloadIds = new Set();
let existingDownloadPaths = null;

function pushLog(type, msg) {
  state.log.push({ type, msg });
  if (state.log.length > 300) state.log.shift();
}

async function saveState() {
  await chrome.storage.session.set({ downloadState: { ...state } });
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: { ...state } }).catch(() => {});

  if (state.status === 'resolving') {
    const pct = state.total > 0 ? Math.round((state.done + state.failed) / state.total * 100) : 0;
    chrome.action.setBadgeText({ text: pct + '%' });
    chrome.action.setBadgeBackgroundColor({ color: '#d69e2e' });
  } else if (state.status === 'running') {
    const pct = state.total > 0 ? Math.round((state.done + state.failed) / state.total * 100) : 0;
    chrome.action.setBadgeText({ text: pct + '%' });
    chrome.action.setBadgeBackgroundColor({ color: '#38a169' });
  } else if (state.status === 'done') {
    chrome.action.setBadgeText({ text: state.failed > 0 ? '!' : 'OK' });
    chrome.action.setBadgeBackgroundColor({ color: state.failed > 0 ? '#e53e3e' : '#38a169' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function resetRunTracking() {
  startedDownloadIds = new Set();
  activeDownloadIds = new Set();
  completedDownloadIds = new Set();
  existingDownloadPaths = null;
}

function sanitize(name) {
  return String(name || '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .substring(0, 80);
}

function filenameFromUrl(url) {
  try {
    const raw = url.split('?')[0].split('/').pop();
    return decodeURIComponent(raw).replace(/[/\\?%*:|"<>]/g, '-').trim();
  } catch {
    return '';
  }
}

function guessExt(url, name) {
  const known = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'zip', 'rar', 'mp4', 'mp3', 'png', 'jpg', 'jpeg', 'gif', 'txt'];
  const urlExt = url.split('?')[0].split('.').pop().toLowerCase();
  if (known.includes(urlExt)) return '.' + urlExt;
  const nameExt = String(name || '').split('.').pop().toLowerCase();
  if (known.includes(nameExt)) return '';
  return '.pdf';
}

function buildFilename(subfolder, courseName, sectionFolder, fileName) {
  return `${subfolder}/${courseName}/${sectionFolder}/${fileName}`;
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
  if (existingDownloadPaths) return existingDownloadPaths;

  const paths = new Set();
  try {
    const items = await chrome.downloads.search({ state: 'complete' });
    items.forEach(item => {
      if (!item || !item.filename) return;
      if (item.exists === false) return;
      paths.add(normalizeRelativePath(downloadHistoryToRelativePath(item.filename)));
    });
  } catch (_) {}

  existingDownloadPaths = paths;
  return paths;
}

function invalidateExistingDownloadPaths() {
  existingDownloadPaths = null;
}

async function hasExistingDownloadPath(filePath) {
  const existingPaths = await loadExistingDownloadPaths();
  return existingPaths.has(normalizeRelativePath(filePath));
}

async function filterExistingItems(items) {
  const existingPaths = await loadExistingDownloadPaths();
  const kept = [];

  for (const item of items) {
    const relPath = normalizeRelativePath(item.filename);
    if (existingPaths.has(relPath)) {
      state.skipped++;
      pushLog('info', `Skipped ${item.name} (already exists)`);
      continue;
    }
    kept.push(item);
  }

  await saveState();
  broadcast();
  return kept;
}

async function refilterExistingItemsAfterRefresh(items) {
  invalidateExistingDownloadPaths();
  await new Promise(r => setTimeout(r, 250));
  return filterExistingItems(items);
}

function pPool(limit) {
  let active = 0;
  const queue = [];

  const run = async (fn, resolve, reject) => {
    active++;
    try {
      resolve(await fn());
    } catch (e) {
      reject(e);
    } finally {
      active--;
      if (queue.length) {
        const [nextFn, nextResolve, nextReject] = queue.shift();
        run(nextFn, nextResolve, nextReject);
      }
    }
  };

  return (fn) => new Promise((resolve, reject) => {
    if (active < limit) run(fn, resolve, reject);
    else queue.push([fn, resolve, reject]);
  });
}

function dataUriToBytes(url) {
  const marker = ';base64,';
  if (url.includes(marker)) {
    const b64 = url.split(marker)[1];
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const payload = url.split(',')[1] || '';
  return new TextEncoder().encode(decodeURIComponent(payload));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function fetchFileBytes(url) {
  if (url.startsWith('data:')) return dataUriToBytes(url);
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

function crc32(bytes) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }

  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const enc = new TextEncoder();
  const w16 = (a, o, v) => { a[o] = v & 0xFF; a[o + 1] = (v >> 8) & 0xFF; };
  const w32 = (a, o, v) => { a[o] = v & 0xFF; a[o + 1] = (v >> 8) & 0xFF; a[o + 2] = (v >> 16) & 0xFF; a[o + 3] = (v >>> 24) & 0xFF; };
  const cat = (arrs) => {
    const out = new Uint8Array(arrs.reduce((sum, arr) => sum + arr.length, 0));
    let pos = 0;
    arrs.forEach(arr => { out.set(arr, pos); pos += arr.length; });
    return out;
  };

  const locals = [];
  const central = [];
  let localOff = 0;

  for (const { name, data } of entries) {
    const nm = enc.encode(name);
    const crc = crc32(data);
    const sz = data.length;

    const lh = new Uint8Array(30 + nm.length);
    w32(lh, 0, 0x04034B50); w16(lh, 4, 20); w16(lh, 6, 0x800); w16(lh, 8, 0);
    w16(lh, 10, 0); w16(lh, 12, 0); w32(lh, 14, crc); w32(lh, 18, sz); w32(lh, 22, sz);
    w16(lh, 26, nm.length); w16(lh, 28, 0); lh.set(nm, 30);

    const ce = new Uint8Array(46 + nm.length);
    w32(ce, 0, 0x02014B50); w16(ce, 4, 20); w16(ce, 6, 20); w16(ce, 8, 0x800); w16(ce, 10, 0);
    w16(ce, 12, 0); w16(ce, 14, 0); w32(ce, 16, crc); w32(ce, 20, sz); w32(ce, 24, sz);
    w16(ce, 28, nm.length); w16(ce, 30, 0); w16(ce, 32, 0); w16(ce, 34, 0); w16(ce, 36, 0);
    w32(ce, 38, 0); w32(ce, 42, localOff); ce.set(nm, 46);

    locals.push(lh, data);
    central.push(ce);
    localOff += lh.length + sz;
  }

  const cd = cat(central);
  const eocd = new Uint8Array(22);
  w32(eocd, 0, 0x06054B50); w16(eocd, 4, 0); w16(eocd, 6, 0);
  w16(eocd, 8, entries.length); w16(eocd, 10, entries.length);
  w32(eocd, 12, cd.length); w32(eocd, 16, localOff); w16(eocd, 20, 0);

  return cat([...locals, cd, eocd]);
}

async function sendResolveMessage(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function resolveTask(tabId, task, courseName, subfolder) {
  const { file, sectionFolder } = task;

  if (file.type === 'text') {
    const fn = sanitize(file.name) + '.md';
    const dataUri = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(file.content);
    return [{ url: dataUri, filename: buildFilename(subfolder, courseName, '_course-info', fn), name: fn }];
  }

  if (file.type === 'direct') {
    const urlFn = filenameFromUrl(file.url);
    const ext = guessExt(file.url, file.name);
    const fn = urlFn || (sanitize(file.name) + ext);
    return [{ url: file.url, filename: buildFilename(subfolder, courseName, sectionFolder, fn), name: file.name }];
  }

  if (file.type === 'resource') {
    const r = await sendResolveMessage(tabId, { action: 'RESOLVE_RESOURCE', url: file.url });
    if (!r?.resolved) return [{ _skip: true, name: file.name, reason: 'Could not resolve' }];
    const urlFn = filenameFromUrl(r.resolved);
    const ext = guessExt(r.resolved, file.name);
    const fn = urlFn || (sanitize(file.name) + ext);
    return [{ url: r.resolved, filename: buildFilename(subfolder, courseName, sectionFolder, fn), name: file.name }];
  }

  if (file.type === 'assign' || file.type === 'quiz') {
    const r = await sendResolveMessage(tabId, { action: 'RESOLVE_ASSIGNMENT', url: file.url });
    const atts = r?.files || [];
    if (atts.length === 0) return [{ _skip: true, name: file.name, reason: 'no attachments' }];
    return atts.map(att => {
      const urlFn = filenameFromUrl(att.url);
      const ext = guessExt(att.url, att.name);
      const fn = urlFn || (sanitize(att.name) + ext);
      return {
        url: att.url,
        filename: buildFilename(subfolder, courseName, sectionFolder, sanitize(file.name) + ' - ' + fn),
        name: att.name,
      };
    });
  }

  if (file.type === 'url') {
    const r = await sendResolveMessage(tabId, { action: 'RESOLVE_URL_MODULE', url: file.url });
    const externalUrl = r?.resolved || file.url;
    const content = `[InternetShortcut]\nURL=${externalUrl}\n`;
    const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
    const fn = sanitize(file.name) + '.url';
    return [{ url: dataUri, filename: buildFilename(subfolder, courseName, sectionFolder, fn), name: file.name }];
  }

  return [];
}

async function resolveAllTasks(runId, job) {
  state.status = 'resolving';
  state.total = job.tasks.length;
  state.done = 0;
  state.skipped = 0;
  state.failed = 0;
  state.currentFile = 'Loading...';
  pushLog('info', 'Loading in background...');
  await saveState();
  broadcast();

  const pool = pPool(RESOLVE_CONCURRENCY);
  let resolved = 0;

  const results = await Promise.all(
    job.tasks.map(task =>
      pool(async () => {
        if (runId !== currentRunId || state.status === 'cancelled') return [];
        let out;
        try {
          out = await resolveTask(job.tabId, task, job.courseName, job.subfolder);
        } catch (e) {
          out = [{ _skip: true, name: task.file.name, reason: e.message || 'error' }];
        }

        if (runId !== currentRunId || state.status === 'cancelled') return [];

        resolved++;
        state.currentFile = 'Loading...';
        state.done = resolved;
        await saveState();
        broadcast();
        return out;
      })
    )
  );

  return results.flat().filter(item => !item._skip);
}

async function cancelDownloadById(downloadId) {
  try {
    await chrome.downloads.cancel(downloadId);
  } catch (_) {}
}

async function removeDownloadedFile(downloadId) {
  try {
    await chrome.downloads.removeFile(downloadId);
  } catch (_) {}
}

async function getDownloadItemsByIds(downloadIds) {
  if (!downloadIds.length) return [];
  try {
    const items = await chrome.downloads.search({});
    const wanted = new Set(downloadIds);
    return items.filter(item => wanted.has(item.id));
  } catch (_) {
    return [];
  }
}

function downloadViaChrome(item, runId) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: item.url, filename: item.filename, conflictAction: 'uniquify', saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err || !id) {
          reject(new Error(err?.message || 'no download ID'));
          return;
        }

        startedDownloadIds.add(id);
        activeDownloadIds.add(id);

        const onChanged = (delta) => {
          if (delta.id !== id) return;
          if (delta.state?.current === 'complete') {
            chrome.downloads.onChanged.removeListener(onChanged);
            activeDownloadIds.delete(id);
            completedDownloadIds.add(id);
            resolve(id);
          } else if (delta.state?.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(onChanged);
            activeDownloadIds.delete(id);
            reject(new Error(delta.error?.current || 'interrupted'));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);

        if (runId !== currentRunId || state.status === 'cancelled') {
          cancelDownloadById(id);
        }
      }
    );
  });
}

async function runDownloadPhase(runId, items) {
  state.status = 'running';
  state.total = items.length;
  state.done = 0;
  state.failed = 0;
  state.currentFile = '';
  pushLog('info', `Found ${items.length} files...`);
  await saveState();
  broadcast();

  let nextIndex = 0;

  async function worker() {
    while (runId === currentRunId && state.status !== 'cancelled') {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;
      const item = items[currentIndex];

      state.currentFile = item.name;
      await saveState();
      broadcast();

      try {
        await downloadViaChrome(item, runId);
        if (runId !== currentRunId || state.status === 'cancelled') return;
        state.done++;
        pushLog('ok', `Saved ${item.name}`);
      } catch (e) {
        if (runId !== currentRunId || state.status === 'cancelled') return;
        state.failed++;
        pushLog('err', `Failed ${item.name}: ${e.message}`);
      }

      if (runId !== currentRunId || state.status === 'cancelled') return;
      await saveState();
      broadcast();
      await new Promise(r => setTimeout(r, 25));
    }
  }

  const workerCount = Math.min(DOWNLOAD_CONCURRENCY, items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function runZipPhase(runId, items, job) {
  state.status = 'running';
  state.total = items.length;
  state.done = 0;
  state.failed = 0;
  state.currentFile = '';
  pushLog('info', `Found ${items.length} files...`);
  await saveState();
  broadcast();

  const entries = [];
  const pfx = `${job.subfolder}/${job.courseName}/`;

  for (const item of items) {
    if (runId !== currentRunId || state.status === 'cancelled') return;
    state.currentFile = item.name;
    await saveState();
    broadcast();

    try {
      const bytes = await fetchFileBytes(item.url);
      const relPath = item.filename.startsWith(pfx)
        ? item.filename.slice(pfx.length)
        : item.filename.split('/').slice(2).join('/');
      entries.push({ name: relPath, data: bytes });
      state.done++;
      pushLog('ok', `Saved ${item.name}`);
    } catch (e) {
      state.failed++;
      pushLog('err', `Failed ${item.name}: ${e.message}`);
    }

    await saveState();
    broadcast();
  }

  if (runId !== currentRunId || state.status === 'cancelled' || entries.length === 0) return;

  state.currentFile = 'Building ZIP...';
  await saveState();
  broadcast();

  const zipData = buildZip(entries);
  const zipUrl = `data:application/zip;base64,${bytesToBase64(zipData)}`;
  const zipFilename = `${job.subfolder}/${job.courseName}.zip`;

  await downloadViaChrome({ url: zipUrl, filename: zipFilename, name: `${job.courseName}.zip` }, runId);
}

async function finalizeRun(runId) {
  if (runId !== currentRunId) return;
  state.status = state.status === 'cancelled' ? 'cancelled' : 'done';
  state.finishedAt = Date.now();
  state.currentFile = '';
  pushLog('info', `Completed: ${state.done} saved, ${state.skipped} skipped, ${state.failed} failed.`);
  await saveState();
  broadcast();
  isRunning = false;
}

async function runJob(runId, job) {
  isRunning = true;

  try {
    if (job.makeZip) {
      const zipFilename = `${job.subfolder}/${job.courseName}.zip`;
      if (await hasExistingDownloadPath(zipFilename)) {
        state.status = 'done';
        state.total = 1;
        state.currentFile = '';
        state.done = 0;
        state.skipped = 1;
        state.failed = 0;
        state.finishedAt = Date.now();
        pushLog('info', `Skipped ${job.courseName}.zip (already exists)`);
        await saveState();
        broadcast();
        isRunning = false;
        return;
      }
    }

    const resolvedItems = await resolveAllTasks(runId, job);
    if (runId !== currentRunId || state.status === 'cancelled') return;

    // Only skip already-downloaded source files for folder mode.
    // ZIP mode should still work after a folder download, because the archive
    // is a separate output artifact from the extracted files.
    let items = job.makeZip ? resolvedItems : await filterExistingItems(resolvedItems);
    if (runId !== currentRunId || state.status === 'cancelled') return;

    // Chrome's download-history existence metadata can lag briefly after the
    // user deletes files or folders. If everything was skipped, refresh once
    // before concluding that nothing needs downloading.
    if (!job.makeZip && resolvedItems.length > 0 && items.length === 0) {
      pushLog('info', 'Rechecking deleted files...');
      await saveState();
      broadcast();
      items = await refilterExistingItemsAfterRefresh(resolvedItems);
      if (runId !== currentRunId || state.status === 'cancelled') return;
    }

    if (items.length === 0) {
      state.status = 'done';
      state.total = resolvedItems.length;
      state.done = 0;
      state.failed = 0;
      state.finishedAt = Date.now();
      state.currentFile = '';
      pushLog('info', 'Nothing left to download after duplicate check.');
      await saveState();
      broadcast();
      isRunning = false;
      return;
    }

    if (job.makeZip) {
      await runZipPhase(runId, items, job);
    } else {
      await runDownloadPhase(runId, items);
    }
  } catch (e) {
    if (runId === currentRunId) {
      state.status = 'done';
      state.currentFile = '';
      pushLog('err', `Job failed: ${e.message}`);
      await saveState();
      broadcast();
    }
    isRunning = false;
    return;
  }

  await finalizeRun(runId);
}

async function rollbackCurrentRun() {
  if (cancelPromise) return cancelPromise;

  cancelPromise = (async () => {
    const idsSeenInRun = [...startedDownloadIds];
    currentRunId++;
    state.status = 'cancelled';
    isRunning = false;
    state.currentFile = '';

    const idsToCancel = [...activeDownloadIds];
    await Promise.all(idsToCancel.map(cancelDownloadById));
    await new Promise(r => setTimeout(r, 400));

    const itemsAfterCancel = await getDownloadItemsByIds(idsSeenInRun);
    const idsToRemove = itemsAfterCancel.filter(item => item.state === 'complete').map(item => item.id);
    await Promise.all(idsToRemove.map(removeDownloadedFile));

    resetRunTracking();
    state = { ...EMPTY_STATE };
    await saveState();
    broadcast();
    cancelPromise = null;
  })();

  return cancelPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'START_DOWNLOAD') {
    if (isRunning || cancelPromise) {
      sendResponse({ error: 'Already downloading' });
      return true;
    }

    currentRunId++;
    resetRunTracking();
    state = {
      ...EMPTY_STATE,
      status: 'resolving',
      total: msg.tasks.length,
      log: [{ type: 'info', msg: `Starting ${msg.tasks.length} items...` }],
      startedAt: Date.now(),
    };
    saveState();
    runJob(currentRunId, msg);
    sendResponse({ started: true });
    return true;
  }

  if (msg.action === 'GET_STATE') {
    sendResponse({ state: { ...state } });
    return true;
  }

  if (msg.action === 'CANCEL') {
    rollbackCurrentRun().then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.storage.session.get('downloadState', (result) => {
  if (result.downloadState) {
    state = result.downloadState;
    if (state.status === 'running' || state.status === 'resolving') {
      state.status = 'done';
      pushLog('err', 'Download was interrupted (service worker restarted).');
      saveState();
      broadcast();
    }
  }
});
