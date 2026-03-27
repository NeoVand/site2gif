// site2gif — Background Service Worker

let state = {
  status: 'idle', // idle | recording | processing | done
  startTime: null,
  tabId: null,
  hasRecording: false,
  duration: 0,
  videoSize: 0,
  settings: {
    fps: 10,
    scale: 1,
    quality: 'medium',
    showCursor: true,
    loop: true
  }
};

chrome.storage.local.get('settings', (r) => {
  if (r.settings) state.settings = { ...state.settings, ...r.settings };
});

function updateBadge() {
  const text = state.status === 'recording' ? 'REC'
    : state.status === 'processing' ? '...'
    : state.hasRecording ? '✓' : '';
  const color = state.status === 'recording' ? '#e94560'
    : state.status === 'processing' ? '#ffaa00' : '#22c55e';
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}
updateBadge();

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Recording tab capture stream'
      });
    }
  } catch (e) {
    console.warn('Offscreen setup:', e);
  }
}

async function startRecording() {
  if (state.status === 'recording') return { error: 'Already recording' };

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tabId = tabs[0]?.id;
    if (!state.tabId) return { error: 'No active tab found' };

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: state.tabId
    });

    await ensureOffscreen();

    if (state.settings.showCursor) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: state.tabId },
          files: ['content.js']
        });
        chrome.tabs.sendMessage(state.tabId, { type: 'start-cursor-tracking' }).catch(() => {});
      } catch (e) {
        console.warn('Cursor tracking unavailable:', e);
      }
    }

    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start-capture',
      streamId
    }).catch(() => {});

    state.status = 'recording';
    state.startTime = Date.now();
    state.hasRecording = false;
    updateBadge();
    broadcast();
    return { ok: true };
  } catch (e) {
    console.error('Start recording failed:', e);
    state.status = 'idle';
    updateBadge();
    broadcast();
    return { error: e.message };
  }
}

async function stopRecording() {
  if (state.status !== 'recording') return { error: 'Not recording' };

  if (state.settings.showCursor && state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { type: 'stop-cursor-tracking' }).catch(() => {});
  }

  state.duration = (Date.now() - state.startTime) / 1000;
  state.status = 'processing';
  updateBadge();
  broadcast();

  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture' }).catch(() => {});
  return { ok: true };
}

function broadcast() {
  chrome.runtime.sendMessage({ type: 'state-update', state: getPublicState() }).catch(() => {});
}

function getPublicState() {
  return {
    status: state.status,
    startTime: state.startTime,
    duration: state.duration,
    settings: state.settings,
    hasRecording: state.hasRecording,
    videoSize: state.videoSize
  };
}

// Keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') {
    if (state.status === 'idle' || state.status === 'done') {
      startRecording();
    } else if (state.status === 'recording') {
      stopRecording();
    }
  }
});

// Message routing
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false;

  switch (msg.type) {
    case 'get-state':
      sendResponse(getPublicState());
      return true;

    case 'start-recording':
      startRecording().then(sendResponse);
      return true;

    case 'stop-recording':
      stopRecording().then(sendResponse);
      return true;

    case 'update-settings':
      state.settings = { ...state.settings, ...msg.settings };
      chrome.storage.local.set({ settings: state.settings });
      sendResponse({ ok: true });
      return true;

    case 'clear':
      state.status = 'idle';
      state.hasRecording = false;
      state.videoSize = 0;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'clear' }).catch(() => {});
      updateBadge();
      broadcast();
      sendResponse({ ok: true });
      return true;

    // Messages FROM offscreen
    case 'recording-ready':
      state.hasRecording = true;
      state.status = 'done';
      state.videoSize = msg.videoSize || 0;
      updateBadge();
      broadcast();
      return false;

    case 'error':
      console.error('Offscreen error:', msg.error);
      if (state.status === 'processing') {
        state.status = state.hasRecording ? 'done' : 'idle';
        updateBadge();
        broadcast();
      }
      return false;
  }
});
