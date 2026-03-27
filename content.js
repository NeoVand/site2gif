// site2gif — Content Script (cursor overlay for tab capture)

(function () {
  if (window.__site2gifCursor) return;
  window.__site2gifCursor = true;

  let cursorEl = null;
  let isTracking = false;
  let styleEl = null;

  const CURSOR_SVG = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
      <path d="M3,2 L3,19 L7.5,14.5 L12,22 L14.5,20.5 L10,13 L16,13 Z"
            fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/>
    </svg>`
  )}`;

  function create() {
    if (cursorEl) return;

    cursorEl = document.createElement('div');
    cursorEl.id = 'site2gif-cursor-overlay';
    cursorEl.style.cssText = [
      'position: fixed',
      'width: 24px',
      'height: 24px',
      'pointer-events: none',
      'z-index: 2147483647',
      'display: none',
      `background-image: url("${CURSOR_SVG}")`,
      'background-size: contain',
      'background-repeat: no-repeat',
      'transform: translate(-2px, -1px)',
      'filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3))'
    ].join(';');

    // Hide real cursor during recording
    styleEl = document.createElement('style');
    styleEl.id = 'site2gif-cursor-style';
    styleEl.textContent = '';

    document.documentElement.appendChild(cursorEl);
    document.documentElement.appendChild(styleEl);
  }

  function onMouseMove(e) {
    if (!cursorEl || !isTracking) return;
    cursorEl.style.left = e.clientX + 'px';
    cursorEl.style.top = e.clientY + 'px';
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start-cursor-tracking') {
      create();
      isTracking = true;
      cursorEl.style.display = 'block';
      styleEl.textContent = '* { cursor: none !important; }';
      document.addEventListener('mousemove', onMouseMove, { passive: true });
      sendResponse({ ok: true });
    } else if (msg.type === 'stop-cursor-tracking') {
      isTracking = false;
      if (cursorEl) cursorEl.style.display = 'none';
      if (styleEl) styleEl.textContent = '';
      document.removeEventListener('mousemove', onMouseMove);
      sendResponse({ ok: true });
    }
    return true;
  });
})();
