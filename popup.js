// site2gif — Popup UI Logic
// GIF generation runs here (not offscreen) for reliability.
// Video blobs stored/read via shared IndexedDB (db.js).

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// DOM
const recordBtn = $('#recordBtn');
const recordBtnLabel = $('#recordBtnLabel');
const previewArea = $('#previewArea');
const previewPlaceholder = $('#previewPlaceholder');
const tabScreenshot = $('#tabScreenshot');
const previewVideo = $('#previewVideo');
const previewGif = $('#previewGif');
const recordingOverlay = $('#recordingOverlay');
const recTimer = $('#recTimer');
const previewTabs = $('#previewTabs');
const durationBadge = $('#durationBadge');
const durationText = $('#durationText');
const progressSection = $('#progressSection');
const progressFill = $('#progressFill');
const progressLabel = $('#progressLabel');
const settingsToggle = $('#settingsToggle');
const settingsPanel = $('#settingsPanel');
const downloadSection = $('#downloadSection');
const controlsSection = $('#controlsSection');
const saveGif = $('#saveGif');
const saveVideo = $('#saveVideo');
const gifBtnText = $('#gifBtnText');
const gifSizeText = $('#gifSizeText');
const videoSizeText = $('#videoSizeText');
const newRecording = $('#newRecording');

// Trim
const trimSection = $('#trimSection');
const trimTrack = $('#trimTrack');
const trimRange = $('#trimRange');
const trimHandleStart = $('#trimHandleStart');
const trimHandleEnd = $('#trimHandleEnd');
const trimPlayhead = $('#trimPlayhead');
const trimStartTime = $('#trimStartTime');
const trimEndTime = $('#trimEndTime');
const trimSelectionLabel = $('#trimSelectionLabel');

let currentState = null;
let timerInterval = null;
let settingsVisible = false;
let activePreviewTab = 'video';
let videoObjectUrl = null;
let gifObjectUrl = null;
let gifWorker = null;
let isGeneratingGif = false;
let gifIsReady = false;

// Trim state (0–1 fractions)
let trimStart = 0;
let trimEnd = 1;
let videoDuration = 0; // actual seconds
let playheadRAF = null;

// ─── Init ───

async function init() {
  const state = await chrome.runtime.sendMessage({ type: 'get-state' });
  if (state) {
    currentState = state;
    syncSettings(state.settings);

    // Check if a GIF already exists in IndexedDB
    try {
      const existingGif = await Site2GifDB.get('gif');
      if (existingGif) gifIsReady = true;
    } catch (e) {}

    await render(state);
  }
  setupListeners();
}

function msg(type, data = {}) {
  return chrome.runtime.sendMessage({ type, ...data });
}

// ─── Render ───

async function render(state) {
  currentState = state;

  switch (state.status) {
    case 'idle':
      showIdleState();
      break;
    case 'recording':
      showRecordingState();
      break;
    case 'processing':
      showProcessingState();
      break;
    case 'done':
      await showDoneState(state);
      break;
  }
}

function showIdleState() {
  controlsSection.style.display = '';
  recordBtn.classList.remove('recording');
  recordBtnLabel.textContent = 'Record';
  recordingOverlay.style.display = 'none';
  previewArea.classList.remove('recording');
  downloadSection.style.display = 'none';
  progressSection.style.display = 'none';
  previewTabs.style.display = 'none';
  durationBadge.style.display = 'none';
  trimSection.style.display = 'none';
  previewVideo.style.display = 'none';
  previewGif.style.display = 'none';
  stopTimer();
  stopPlayheadTracker();
  captureTabPreview();
}

function showRecordingState() {
  controlsSection.style.display = '';
  recordBtn.classList.add('recording');
  recordBtnLabel.textContent = 'Stop';
  previewArea.classList.add('recording');
  recordingOverlay.style.display = '';
  downloadSection.style.display = 'none';
  progressSection.style.display = 'none';
  previewTabs.style.display = 'none';
  durationBadge.style.display = 'none';
  trimSection.style.display = 'none';
  previewVideo.style.display = 'none';
  previewGif.style.display = 'none';
  startTimer();
  stopPlayheadTracker();
  captureTabPreview();
}

function showProcessingState() {
  controlsSection.style.display = 'none';
  recordingOverlay.style.display = 'none';
  previewArea.classList.remove('recording');
  downloadSection.style.display = 'none';
  previewTabs.style.display = 'none';
  progressSection.style.display = '';
  progressFill.style.width = '100%';
  progressLabel.textContent = 'Finalizing recording...';
  stopTimer();
}

async function showDoneState(state) {
  controlsSection.style.display = 'none';
  recordingOverlay.style.display = 'none';
  previewArea.classList.remove('recording');
  stopTimer();

  // Duration
  if (state.duration) {
    durationBadge.style.display = '';
    durationText.textContent = formatDuration(state.duration);
  }

  // Download section — always visible when done
  downloadSection.style.display = '';
  videoSizeText.textContent = formatSize(state.videoSize);

  // GIF button state
  updateGifButton();

  // Hide gif-generation progress if not generating
  if (!isGeneratingGif) {
    progressSection.style.display = 'none';
  }

  // Preview tabs
  previewTabs.style.display = gifIsReady ? '' : 'none';

  // Trim timeline
  trimSection.style.display = '';

  // Load video preview
  await loadVideoPreview();
}

function updateGifButton() {
  if (gifIsReady) {
    gifBtnText.textContent = 'Save as GIF';
    Site2GifDB.get('gif').then(blob => {
      if (blob) gifSizeText.textContent = formatSize(blob.size);
    }).catch(() => {});
    saveGif.disabled = false;
  } else if (isGeneratingGif) {
    gifBtnText.textContent = 'Generating...';
    saveGif.disabled = true;
  } else {
    gifBtnText.textContent = 'Save as GIF';
    gifSizeText.textContent = 'Click to generate & save';
    saveGif.disabled = false;
  }
}

// ─── Tab Screenshot ───

async function captureTabPreview() {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: 'jpeg',
      quality: 70
    });
    tabScreenshot.src = dataUrl;
    tabScreenshot.style.display = '';
    previewPlaceholder.style.display = 'none';
  } catch (e) {
    tabScreenshot.style.display = 'none';
    previewPlaceholder.style.display = '';
  }
}

// ─── Video/GIF Preview ───

async function loadVideoPreview() {
  try {
    const blob = await Site2GifDB.get('video');
    if (!blob) return;

    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = URL.createObjectURL(blob);

    tabScreenshot.style.display = 'none';
    previewPlaceholder.style.display = 'none';
    previewGif.style.display = 'none';
    previewVideo.style.display = '';
    previewVideo.src = videoObjectUrl;

    // Resolve duration (Chrome WebM Infinity bug)
    await new Promise((resolve) => {
      previewVideo.onloadedmetadata = resolve;
      if (previewVideo.readyState >= 1) resolve();
    });

    videoDuration = previewVideo.duration;
    if (!isFinite(videoDuration) || videoDuration <= 0) {
      if (currentState?.duration && isFinite(currentState.duration) && currentState.duration > 0) {
        videoDuration = currentState.duration;
      } else {
        // Discover by seeking to end
        previewVideo.currentTime = 1e10;
        await new Promise(r => { previewVideo.onseeked = r; setTimeout(r, 3000); });
        videoDuration = previewVideo.currentTime || 10;
        previewVideo.currentTime = 0;
        await new Promise(r => { previewVideo.onseeked = r; setTimeout(r, 1000); });
      }
    }

    // Init trim UI with resolved duration
    updateTrimUI();

    // Play within trim range
    previewVideo.currentTime = trimStart * videoDuration;
    previewVideo.play().catch(() => {});
    startPlayheadTracker();
  } catch (e) {
    console.warn('Video preview failed:', e);
  }
}

async function loadGifPreview() {
  try {
    const blob = await Site2GifDB.get('gif');
    if (!blob) return;

    if (gifObjectUrl) URL.revokeObjectURL(gifObjectUrl);
    gifObjectUrl = URL.createObjectURL(blob);

    previewVideo.style.display = 'none';
    tabScreenshot.style.display = 'none';
    previewPlaceholder.style.display = 'none';
    previewGif.style.display = '';
    previewGif.src = gifObjectUrl;
  } catch (e) {
    console.warn('GIF preview failed:', e);
  }
}

// ─── GIF Generation (runs entirely in popup) ───

async function generateAndSaveGif() {
  if (isGeneratingGif) return;
  isGeneratingGif = true;
  updateGifButton();

  progressSection.style.display = '';
  progressFill.style.width = '0%';
  progressLabel.textContent = 'Loading video...';

  try {
    const videoBlob = await Site2GifDB.get('video');
    if (!videoBlob) {
      throw new Error('No recording found in storage');
    }

    const settings = currentState?.settings || {};
    const { fps = 10, scale = 1, quality = 'medium', loop = true } = settings;

    // Load video into hidden video element
    const video = $('#gifSourceVideo');
    const url = URL.createObjectURL(videoBlob);
    video.src = url;

    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Could not load video'));
      video.load();
    });

    // Wait for video to be seekable
    if (video.readyState < 2) {
      await new Promise((resolve) => {
        video.oncanplay = resolve;
      });
    }

    // Scale proportionally — preserves original aspect ratio exactly
    let outWidth = Math.round(video.videoWidth * scale);
    let outHeight = Math.round(video.videoHeight * scale);
    outWidth = Math.max(2, outWidth & ~1);
    outHeight = Math.max(2, outHeight & ~1);

    const canvas = $('#gifCanvas');
    canvas.width = outWidth;
    canvas.height = outHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Chrome's MediaRecorder produces WebM without duration metadata,
    // so video.duration is often Infinity. Fix it by seeking to the end.
    let duration = video.duration;
    if (!isFinite(duration)) {
      // Use the known recording duration from background state
      if (currentState?.duration && isFinite(currentState.duration) && currentState.duration > 0) {
        duration = currentState.duration;
      } else {
        // Fallback: seek to a large time — browser clamps to actual end
        video.currentTime = 1e10;
        await new Promise(r => {
          video.onseeked = r;
          setTimeout(r, 3000); // safety timeout
        });
        duration = video.currentTime;
        video.currentTime = 0;
        await new Promise(r => {
          video.onseeked = r;
          setTimeout(r, 1000);
        });
      }
    }

    if (!isFinite(duration) || duration <= 0) {
      throw new Error('Could not determine video duration');
    }

    // Apply trim range
    const clipStart = trimStart * duration;
    const clipEnd = trimEnd * duration;
    const clipDuration = clipEnd - clipStart;

    const frameInterval = 1 / fps;
    const totalFrames = Math.max(1, Math.floor(clipDuration * fps));

    progressLabel.textContent = 'Extracting frames...';

    // Extract frames with robust seeking (only within trim range)
    const frames = [];
    for (let i = 0; i < totalFrames; i++) {
      const t = Math.min(clipStart + i * frameInterval, clipEnd - 0.001);

      // Seek and wait
      await seekVideo(video, t);

      ctx.drawImage(video, 0, 0, outWidth, outHeight);
      const imageData = ctx.getImageData(0, 0, outWidth, outHeight);
      frames.push(imageData.data.buffer);

      const pct = Math.round(((i + 1) / totalFrames) * 40);
      progressFill.style.width = pct + '%';
      progressLabel.textContent = `Extracting frames... ${i + 1}/${totalFrames}`;

      // Yield to keep UI responsive
      if (i % 5 === 0) await yieldToUI();
    }

    URL.revokeObjectURL(url);

    progressLabel.textContent = 'Encoding GIF...';

    // Encode GIF in web worker
    const gifData = await encodeGifInWorker(frames, outWidth, outHeight, fps, quality, loop);

    const gifBlob = new Blob([gifData], { type: 'image/gif' });

    // Store in IndexedDB
    await Site2GifDB.put('gif', gifBlob);
    gifIsReady = true;

    progressFill.style.width = '100%';
    progressLabel.textContent = `GIF ready — ${formatSize(gifBlob.size)}`;

    // Update UI
    updateGifButton();
    previewTabs.style.display = '';

    // Auto-download
    triggerDownload(gifBlob, `site2gif-${timestamp()}.gif`);

    // Brief pause to show completion, then hide progress
    setTimeout(() => {
      progressSection.style.display = 'none';
    }, 1500);

  } catch (e) {
    console.error('GIF generation failed:', e);
    progressLabel.textContent = `Error: ${e.message}`;
    progressFill.style.width = '0%';
    setTimeout(() => { progressSection.style.display = 'none'; }, 3000);
  } finally {
    isGeneratingGif = false;
    updateGifButton();
  }
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
    // If already very close, skip seeking
    if (Math.abs(video.currentTime - time) < 0.02) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;

    // Safety timeout in case seeked never fires
    setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }, 2000);
  });
}

function encodeGifInWorker(frames, width, height, fps, quality, loop) {
  return new Promise((resolve, reject) => {
    if (gifWorker) gifWorker.terminate();
    gifWorker = new Worker('gif-worker.js');

    gifWorker.onmessage = (e) => {
      if (e.data.type === 'progress') {
        const pct = Math.round(40 + e.data.value * 60);
        progressFill.style.width = pct + '%';
        progressLabel.textContent = `Encoding GIF... ${pct}%`;
      } else if (e.data.type === 'done') {
        gifWorker.terminate();
        gifWorker = null;
        resolve(e.data.data);
      }
    };

    gifWorker.onerror = (e) => {
      gifWorker.terminate();
      gifWorker = null;
      reject(new Error('GIF worker error: ' + e.message));
    };

    const transferables = frames.slice();
    gifWorker.postMessage(
      { frames, width, height, fps, quality, loop },
      transferables
    );
  });
}

function yieldToUI() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─── Trim ───

function updateTrimUI() {
  const startPct = trimStart * 100;
  const endPct = trimEnd * 100;

  trimRange.style.left = startPct + '%';
  trimRange.style.right = (100 - endPct) + '%';
  trimHandleStart.style.left = `calc(${startPct}% - 7px)`;
  trimHandleEnd.style.left = `calc(${endPct}% - 7px)`;

  const startSec = trimStart * videoDuration;
  const endSec = trimEnd * videoDuration;
  trimStartTime.textContent = formatTimePrecise(startSec);
  trimEndTime.textContent = formatTimePrecise(endSec);

  const selectedSec = endSec - startSec;
  if (trimStart === 0 && trimEnd === 1) {
    trimSelectionLabel.textContent = 'Full clip';
  } else {
    trimSelectionLabel.textContent = formatTimePrecise(selectedSec) + ' selected';
  }
}

function formatTimePrecise(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0
    ? `${m}:${s.toFixed(1).padStart(4, '0')}`
    : s.toFixed(1) + 's';
}

function initTrimDrag() {
  let dragging = null; // 'start' | 'end' | null

  function pctFromEvent(e) {
    const rect = trimTrack.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  trimHandleStart.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = 'start';
    trimHandleStart.classList.add('dragging');
    trimHandleStart.setPointerCapture(e.pointerId);
  });

  trimHandleEnd.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = 'end';
    trimHandleEnd.classList.add('dragging');
    trimHandleEnd.setPointerCapture(e.pointerId);
  });

  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const pct = pctFromEvent(e);

    if (dragging === 'start') {
      trimStart = Math.min(pct, trimEnd - 0.01);
    } else {
      trimEnd = Math.max(pct, trimStart + 0.01);
    }

    // Invalidate cached GIF when trim changes
    if (gifIsReady) {
      gifIsReady = false;
      updateGifButton();
      previewTabs.style.display = 'none';
    }

    updateTrimUI();

    // Scrub video preview to handle position
    if (previewVideo.src && videoDuration > 0) {
      const t = (dragging === 'start' ? trimStart : trimEnd) * videoDuration;
      previewVideo.currentTime = t;
    }
  });

  document.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    trimHandleStart.classList.remove('dragging');
    trimHandleEnd.classList.remove('dragging');
    dragging = null;

    // Resume playback from trim start
    if (previewVideo.src && videoDuration > 0 && activePreviewTab === 'video') {
      previewVideo.currentTime = trimStart * videoDuration;
      previewVideo.play().catch(() => {});
    }
  });

  // Click on track to seek
  trimTrack.addEventListener('click', (e) => {
    if (e.target === trimHandleStart || e.target === trimHandleEnd) return;
    const pct = pctFromEvent(e);
    if (previewVideo.src && videoDuration > 0) {
      previewVideo.currentTime = pct * videoDuration;
      previewVideo.play().catch(() => {});
    }
  });
}

function startPlayheadTracker() {
  stopPlayheadTracker();
  function tick() {
    if (previewVideo && videoDuration > 0 && !previewVideo.paused) {
      const pct = (previewVideo.currentTime / videoDuration) * 100;
      trimPlayhead.style.left = pct + '%';

      // Loop within trim range
      if (previewVideo.currentTime >= trimEnd * videoDuration) {
        previewVideo.currentTime = trimStart * videoDuration;
      }
    }
    playheadRAF = requestAnimationFrame(tick);
  }
  playheadRAF = requestAnimationFrame(tick);
}

function stopPlayheadTracker() {
  if (playheadRAF) {
    cancelAnimationFrame(playheadRAF);
    playheadRAF = null;
  }
}

// ─── Timer ───

function startTimer() {
  if (timerInterval) return;
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 200);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  if (!currentState?.startTime) return;
  const elapsed = (Date.now() - currentState.startTime) / 1000;
  recTimer.textContent = formatDuration(elapsed);
}

// ─── Settings ───

function syncSettings(settings) {
  if (!settings) return;
  $$('#fpsGroup .pill').forEach(p => p.classList.toggle('active', p.dataset.value === String(settings.fps)));
  $$('#scaleGroup .pill').forEach(p => p.classList.toggle('active', p.dataset.value === String(settings.scale)));
  $$('#qualityGroup .pill').forEach(p => p.classList.toggle('active', p.dataset.value === settings.quality));
  $('#showCursor').checked = settings.showCursor;
  $('#loopGif').checked = settings.loop;
}

function updateSetting(key, value) {
  msg('update-settings', { settings: { [key]: value } });
}

// ─── Events ───

function setupListeners() {
  // Record / Stop
  recordBtn.addEventListener('click', () => {
    if (currentState?.status === 'recording') {
      msg('stop-recording');
    } else {
      msg('start-recording');
    }
  });

  // Settings
  settingsToggle.addEventListener('click', () => {
    settingsVisible = !settingsVisible;
    settingsPanel.style.display = settingsVisible ? '' : 'none';
    settingsToggle.classList.toggle('active', settingsVisible);
  });

  setupPillGroup('fpsGroup', 'fps', parseInt);
  setupPillGroup('scaleGroup', 'scale', parseFloat);
  setupPillGroup('qualityGroup', 'quality', String);
  $('#showCursor').addEventListener('change', (e) => updateSetting('showCursor', e.target.checked));
  $('#loopGif').addEventListener('change', (e) => updateSetting('loop', e.target.checked));

  // Save as GIF — generates locally then downloads
  saveGif.addEventListener('click', async () => {
    if (gifIsReady) {
      const blob = await Site2GifDB.get('gif');
      if (blob) triggerDownload(blob, `site2gif-${timestamp()}.gif`);
    } else {
      generateAndSaveGif();
    }
  });

  // Save as Video — trim if needed, then download
  saveVideo.addEventListener('click', async () => {
    const blob = await Site2GifDB.get('video');
    if (!blob) return;

    // If no trim, download original
    if (trimStart === 0 && trimEnd === 1) {
      triggerDownload(blob, `site2gif-${timestamp()}.webm`);
      return;
    }

    // Re-encode trimmed video via canvas + MediaRecorder
    try {
      saveVideo.disabled = true;
      videoSizeText.textContent = 'Trimming...';
      const trimmedBlob = await exportTrimmedVideo(blob);
      triggerDownload(trimmedBlob, `site2gif-${timestamp()}.webm`);
      videoSizeText.textContent = formatSize(trimmedBlob.size);
    } catch (e) {
      console.error('Video trim failed:', e);
      videoSizeText.textContent = 'Trim failed';
    } finally {
      saveVideo.disabled = false;
    }
  });

  // Preview tabs
  $$('.preview-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.preview-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activePreviewTab = tab.dataset.tab;
      if (activePreviewTab === 'gif') loadGifPreview();
      else loadVideoPreview();
    });
  });

  // New recording
  newRecording.addEventListener('click', () => {
    if (videoObjectUrl) { URL.revokeObjectURL(videoObjectUrl); videoObjectUrl = null; }
    if (gifObjectUrl) { URL.revokeObjectURL(gifObjectUrl); gifObjectUrl = null; }
    if (gifWorker) { gifWorker.terminate(); gifWorker = null; }
    previewVideo.src = '';
    previewGif.src = '';
    activePreviewTab = 'video';
    gifIsReady = false;
    isGeneratingGif = false;
    trimStart = 0;
    trimEnd = 1;
    videoDuration = 0;
    stopPlayheadTracker();
    $$('.preview-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'video'));
    msg('clear');
  });

  // Init trim drag handlers
  initTrimDrag();

  // State updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'state-update') {
      render(message.state);
    }
  });
}

function setupPillGroup(groupId, settingKey, parseFn) {
  $$(`#${groupId} .pill`).forEach(pill => {
    pill.addEventListener('click', () => {
      $$(`#${groupId} .pill`).forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      updateSetting(settingKey, parseFn(pill.dataset.value));
    });
  });
}

// ─── Trimmed Video Export ───

async function exportTrimmedVideo(videoBlob) {
  const video = $('#gifSourceVideo');
  const url = URL.createObjectURL(videoBlob);
  video.src = url;
  video.muted = true;

  await new Promise((resolve) => {
    video.onloadeddata = resolve;
    video.load();
  });
  if (video.readyState < 2) {
    await new Promise(r => { video.oncanplay = r; });
  }

  const canvas = $('#gifCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });

  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const startSec = trimStart * videoDuration;
  const endSec = trimEnd * videoDuration;

  video.currentTime = startSec;
  await new Promise(r => { video.onseeked = r; setTimeout(r, 2000); });

  return new Promise((resolve, reject) => {
    recorder.onstop = () => {
      URL.revokeObjectURL(url);
      resolve(new Blob(chunks, { type: mimeType }));
    };
    recorder.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };

    recorder.start(100);
    video.play();

    // Draw frames and stop at trim end
    function drawFrame() {
      if (video.currentTime >= endSec || video.ended) {
        video.pause();
        recorder.stop();
        return;
      }
      ctx.drawImage(video, 0, 0);
      requestAnimationFrame(drawFrame);
    }
    requestAnimationFrame(drawFrame);
  });
}

// ─── Download ───

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ─── Helpers ───

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function timestamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    (d.getMonth() + 1).toString().padStart(2, '0'),
    d.getDate().toString().padStart(2, '0'),
    '-',
    d.getHours().toString().padStart(2, '0'),
    d.getMinutes().toString().padStart(2, '0'),
    d.getSeconds().toString().padStart(2, '0')
  ].join('');
}

// ─── Boot ───
init();
