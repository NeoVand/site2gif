// Talkover — Background Service Worker

let state = {
  status: 'idle',
  startTime: null,
  tabId: null,
  hasRecording: false,
  duration: 0,
  videoSize: 0,
  settings: {
    fps: 10,
    scale: 1,
    quality: 'medium',
    loop: true,
    audioEnabled: false,
    micDeviceId: '',
    webcamEnabled: false,
    webcamDeviceId: '',
    webcamPosition: 'BR',
    webcamShape: 'rect'
  }
};

chrome.storage.local.get('settings', (r) => {
  if (r.settings) state.settings = { ...state.settings, ...r.settings };
});

function updateBadge() {
  const text = state.status === 'recording' ? 'REC'
    : state.status === 'processing' ? '...'
    : state.hasRecording ? '\u2713' : '';
  const color = state.status === 'recording' ? '#ef4444'
    : state.status === 'processing' ? '#f59e0b' : '#22c55e';
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color });
}
updateBadge();

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Recording tab capture stream with audio/webcam'
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

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.tabId });
    await ensureOffscreen();

    // Get the tab's actual viewport dimensions for capture constraints
    const tabInfo = await chrome.tabs.get(state.tabId);
    const tabWidth = tabInfo.width || 0;
    const tabHeight = tabInfo.height || 0;

    // Send full config to offscreen for audio/webcam support
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start-capture',
      streamId,
      tabWidth,
      tabHeight,
      audioEnabled: state.settings.audioEnabled,
      micDeviceId: state.settings.micDeviceId,
      webcamEnabled: state.settings.webcamEnabled,
      webcamDeviceId: state.settings.webcamDeviceId,
      webcamPosition: state.settings.webcamPosition,
      webcamShape: state.settings.webcamShape
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
    videoSize: state.videoSize,
    hasTabAudio: state.hasTabAudio || false,
    hasMic: state.hasMic || false
  };
}

// ─── Tab switch during recording ───

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (state.status !== 'recording') return;
  if (activeInfo.tabId === state.tabId) return;

  const oldTabId = state.tabId;
  const newTabId = activeInfo.tabId;

  try {
    // Get new stream for the new tab
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: newTabId });
    const tabInfo = await chrome.tabs.get(newTabId);

    // Tell offscreen to switch to the new tab's stream
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'switch-tab',
      streamId,
      tabWidth: tabInfo.width || 0,
      tabHeight: tabInfo.height || 0,
      audioEnabled: state.settings.audioEnabled
    }).catch(() => {});

    state.tabId = newTabId;
  } catch (e) {
    console.warn('Tab switch capture failed:', e);
    // Recording continues on the old tab
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') {
    if (state.status === 'idle' || state.status === 'done') startRecording();
    else if (state.status === 'recording') stopRecording();
  }
});

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
    case 'recording-ready':
      state.hasRecording = true;
      state.status = 'done';
      state.videoSize = msg.videoSize || 0;
      state.hasTabAudio = msg.hasTabAudio || false;
      state.hasMic = msg.hasMic || false;
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
