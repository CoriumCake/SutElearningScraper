(() => {
  const STORAGE_KEY = 'floaterPos';
  const PANEL_W = 420;
  const PANEL_H = 580;

  let container = null;
  let visible = false;

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function createPanel(x, y) {
    container = document.createElement('div');
    container.id = '__sut-scraper-floater__';

    Object.assign(container.style, {
      position: 'fixed',
      left: x + 'px',
      top: y + 'px',
      width: PANEL_W + 'px',
      zIndex: '2147483647',
      boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.18)',
      borderRadius: '12px',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'sans-serif',
    });

    const handle = document.createElement('div');
    Object.assign(handle.style, {
      height: '22px',
      background: 'linear-gradient(135deg, #c06830, #d08838)',
      cursor: 'grab',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      userSelect: 'none',
      flexShrink: '0',
    });

    const grip = document.createElement('span');
    grip.textContent = ':::';
    Object.assign(grip.style, {
      color: 'rgba(255,255,255,0.6)',
      fontSize: '14px',
      lineHeight: '1',
      pointerEvents: 'none',
    });
    handle.appendChild(grip);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'X';
    Object.assign(closeBtn.style, {
      position: 'absolute',
      right: '8px',
      top: '3px',
      background: 'none',
      border: 'none',
      color: 'rgba(255,255,255,0.8)',
      cursor: 'pointer',
      fontSize: '13px',
      lineHeight: '1',
      padding: '2px 4px',
      borderRadius: '4px',
    });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'white'; closeBtn.style.background = 'rgba(255,255,255,0.15)'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'rgba(255,255,255,0.8)'; closeBtn.style.background = 'none'; });
    closeBtn.addEventListener('click', () => hidePanel());
    handle.appendChild(closeBtn);

    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('popup.html');
    Object.assign(iframe.style, {
      width: '100%',
      height: PANEL_H + 'px',
      border: 'none',
      display: 'block',
      background: '#f5f7fa',
    });
    iframe.setAttribute('allowtransparency', 'false');

    container.appendChild(handle);
    container.appendChild(iframe);
    document.body.appendChild(container);

    let dragging = false;
    let offsetX = 0, offsetY = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn) return;
      dragging = true;
      offsetX = e.clientX - container.getBoundingClientRect().left;
      offsetY = e.clientY - container.getBoundingClientRect().top;
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const newX = clamp(e.clientX - offsetX, 0, vw - PANEL_W);
      const newY = clamp(e.clientY - offsetY, 0, vh - 50);
      container.style.left = newX + 'px';
      container.style.top = newY + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.style.cursor = 'grab';
      const rect = container.getBoundingClientRect();
      chrome.storage.local.set({ [STORAGE_KEY]: { x: rect.left, y: rect.top } });
    });
  }

  function showPanel() {
    if (!container) {
      chrome.storage.local.get(STORAGE_KEY, (res) => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const saved = res[STORAGE_KEY];
        const x = saved ? clamp(saved.x, 0, vw - PANEL_W) : vw - PANEL_W - 24;
        const y = saved ? clamp(saved.y, 0, vh - 50) : 80;
        createPanel(x, y);
      });
    } else {
      container.style.display = 'flex';
    }
    visible = true;
  }

  function hidePanel() {
    if (container) container.style.display = 'none';
    visible = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'TOGGLE_PANEL') {
      if (visible) hidePanel();
      else showPanel();
    }
  });
})();

