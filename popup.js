// site2gif — Popup Controller
// Polished UI with mic level monitor, proper permissions, audio/webcam controls.

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ─── DOM ───

// Capture view
const viewCapture = $('#viewCapture');
const previewArea = $('#previewArea');
const previewPlaceholder = $('#previewPlaceholder');
const tabScreenshot = $('#tabScreenshot');
const webcamLive = $('#webcamLive');
const processingOverlay = $('#processingOverlay');
const recordingOverlay = $('#recordingOverlay');
const recTimer = $('#recTimer');
const recordBtn = $('#recordBtn');
const audioPanel = $('#audioPanel');
const webcamPanel = $('#webcamPanel');
const micSelect = $('#micSelect');
const webcamSelect = $('#webcamSelect');
const micLevel = $('#micLevel');
const micPermHint = $('#micPermHint');
const camPermHint = $('#camPermHint');
const permHintsRow = $('#permHintsRow');

// Done view
const viewDone = $('#viewDone');
const durationText = $('#durationText');
const previewVideo = $('#previewVideo');
const doneWebcam = $('#doneWebcam');
const previewGif = $('#previewGif');
const previewTabs = $('#previewTabs');
const trimTrack = $('#trimTrack');
const trimRange = $('#trimRange');
const trimHandleStart = $('#trimHandleStart');
const trimHandleEnd = $('#trimHandleEnd');
const trimPlayhead = $('#trimPlayhead');
const trimStartTime = $('#trimStartTime');
const trimEndTime = $('#trimEndTime');
const trimSelectionLabel = $('#trimSelectionLabel');
const gifOpts = $('#gifOpts');
const videoInfo = $('#videoInfo');
const progressSection = $('#progressSection');
const progressFill = $('#progressFill');
const progressLabel = $('#progressLabel');
const saveBtn = $('#saveBtn');
const saveBtnText = $('#saveBtnText');
const saveBtnSize = $('#saveBtnSize');
const newRecording = $('#newRecording');

// ─── State ───

let currentState = null;
let timerInterval = null;
let selectedFormat = 'gif';
let activePreviewTab = 'video';
let videoObjectUrl = null;
let gifObjectUrl = null;
let gifWorker = null;
let isGeneratingGif = false;
let gifIsReady = false;
let trimStart = 0;
let trimEnd = 1;
let videoDuration = 0;
let playheadRAF = null;
let webcamPreviewStream = null;
let doneWebcamUrl = null;

// Mic monitoring
const MIC_BAR_COUNT = 20;
let micMonitorCtx = null;
let micMonitorAnalyser = null;
let micMonitorStream = null;
let micMonitorRAF = null;

// ─── Init ───

async function init() {
  createMicBars();
  const state = await chrome.runtime.sendMessage({ type: 'get-state' });
  if (state) {
    currentState = state;
    syncSettings(state.settings);
    try { if (await Site2GifDB.get('gif')) gifIsReady = true; } catch (e) {}
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
  if (state.status === 'done') {
    viewCapture.style.display = 'none';
    viewDone.style.display = '';
    await showDoneState(state);
  } else {
    viewCapture.style.display = '';
    viewDone.style.display = 'none';
    if (state.status === 'recording') showRecordingState();
    else if (state.status === 'processing') showProcessingState();
    else showIdleState();
  }
}

function showIdleState() {
  recordBtn.classList.remove('recording');
  recordingOverlay.style.display = 'none';
  processingOverlay.style.display = 'none';
  previewArea.classList.remove('recording');
  stopTimer();
  stopPlayheadTracker();
  captureTabPreview();
}

function showRecordingState() {
  recordBtn.classList.add('recording');
  previewArea.classList.add('recording');
  recordingOverlay.style.display = '';
  processingOverlay.style.display = 'none';
  startTimer();
  captureTabPreview();
}

function showProcessingState() {
  recordBtn.classList.remove('recording');
  recordingOverlay.style.display = 'none';
  previewArea.classList.remove('recording');
  processingOverlay.style.display = '';
  tabScreenshot.style.display = 'none';
  previewPlaceholder.style.display = 'none';
  stopTimer();
}

async function showDoneState(state) {
  stopTimer();
  durationText.textContent = state.duration ? fmtDur(state.duration) : '';

  // Auto-select "video" format when audio or webcam was used (GIF can't have audio)
  if (state.settings?.audioEnabled || state.settings?.webcamEnabled) {
    selectedFormat = 'video';
    $$('.format-opt').forEach(b => {
      b.classList.toggle('active', b.dataset.format === 'video');
    });
    gifOpts.style.display = 'none';
    videoInfo.style.display = '';
  }

  updateSaveButton();
  if (!isGeneratingGif) progressSection.style.display = 'none';
  previewTabs.style.display = gifIsReady ? '' : 'none';
  await loadVideoPreview();
}

function updateSaveButton() {
  if (selectedFormat === 'gif') {
    saveBtn.classList.remove('video-mode');
    if (isGeneratingGif) {
      saveBtnText.textContent = 'Generating...';
      saveBtnSize.textContent = '';
      saveBtn.disabled = true;
    } else if (gifIsReady) {
      saveBtnText.textContent = 'Save GIF';
      saveBtn.disabled = false;
      Site2GifDB.get('gif').then(b => { if (b) saveBtnSize.textContent = fmtSize(b.size); }).catch(() => {});
    } else {
      saveBtnText.textContent = 'Save GIF';
      saveBtnSize.textContent = '';
      saveBtn.disabled = false;
    }
  } else {
    saveBtn.classList.add('video-mode');
    saveBtnText.textContent = 'Save Video';
    saveBtnSize.textContent = fmtSize(currentState?.videoSize);
    saveBtn.disabled = false;
  }
}

// ─── Tab Screenshot ───

async function captureTabPreview() {
  try {
    const url = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 70 });
    tabScreenshot.src = url;
    tabScreenshot.style.display = '';
    previewPlaceholder.style.display = 'none';
  } catch (e) {
    tabScreenshot.style.display = 'none';
    previewPlaceholder.style.display = '';
  }
}

// ─── Video / GIF Preview ───

async function loadVideoPreview() {
  try {
    const blob = await Site2GifDB.get('video');
    if (!blob) return;
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = URL.createObjectURL(blob);
    previewGif.style.display = 'none';
    previewVideo.style.display = '';
    previewVideo.src = videoObjectUrl;

    await new Promise(r => {
      previewVideo.onloadedmetadata = r;
      if (previewVideo.readyState >= 1) r();
    });

    videoDuration = previewVideo.duration;
    if (!isFinite(videoDuration) || videoDuration <= 0) {
      if (currentState?.duration > 0 && isFinite(currentState.duration)) {
        videoDuration = currentState.duration;
      } else {
        previewVideo.currentTime = 1e10;
        await new Promise(r => { previewVideo.onseeked = r; setTimeout(r, 3000); });
        videoDuration = previewVideo.currentTime || 10;
        previewVideo.currentTime = 0;
        await new Promise(r => { previewVideo.onseeked = r; setTimeout(r, 1000); });
      }
    }

    console.log(`[site2gif] Preview: video=${previewVideo.videoWidth}x${previewVideo.videoHeight}, duration=${videoDuration}`);
    // Show dimensions in the UI so we can verify the capture resolution
    durationText.textContent = (currentState?.duration ? fmtDur(currentState.duration) : fmtDur(videoDuration))
      + ` · ${previewVideo.videoWidth}×${previewVideo.videoHeight}`;

    // Load webcam overlay (recorded as separate stream, composited here via CSS)
    try {
      const wcBlob = await Site2GifDB.get('webcam');
      if (wcBlob) {
        if (doneWebcamUrl) URL.revokeObjectURL(doneWebcamUrl);
        doneWebcamUrl = URL.createObjectURL(wcBlob);
        doneWebcam.src = doneWebcamUrl;
        doneWebcam.style.display = '';
        // Apply position and shape from settings
        const pos = currentState?.settings?.webcamPosition || 'BR';
        const shape = currentState?.settings?.webcamShape || 'rect';
        doneWebcam.classList.remove('pos-TL', 'pos-TR', 'pos-BL', 'pos-BR');
        doneWebcam.classList.add('pos-' + pos);
        doneWebcam.classList.remove('shape-circle', 'shape-square', 'shape-rect');
        doneWebcam.classList.add('shape-' + shape);
        doneWebcam.play().catch(() => {});
      } else {
        doneWebcam.style.display = 'none';
      }
    } catch (e) { doneWebcam.style.display = 'none'; }

    updateTrimUI();
    previewVideo.currentTime = trimStart * videoDuration;
    previewVideo.play().catch(() => {});
    startPlayheadTracker();
  } catch (e) { console.warn('Video preview failed:', e); }
}

async function loadGifPreview() {
  try {
    const blob = await Site2GifDB.get('gif');
    if (!blob) return;
    if (gifObjectUrl) URL.revokeObjectURL(gifObjectUrl);
    gifObjectUrl = URL.createObjectURL(blob);
    previewVideo.style.display = 'none';
    previewGif.style.display = '';
    previewGif.src = gifObjectUrl;
  } catch (e) {}
}

// ─── Device Enumeration ───
// NOTE: getUserMedia CANNOT be called from an extension popup — Chrome dismisses
// the permission prompt when the popup loses focus. Instead, we just enumerate
// devices and check if labels are available. If not, we direct the user to
// permissions.html (opened in a real tab) where the prompt can properly appear.

// ─── Helpers ───

function updatePermHintsRow() {
  const anyVisible = micPermHint.classList.contains('show') || camPermHint.classList.contains('show');
  permHintsRow.style.display = anyVisible ? '' : 'none';
}

function updateWebcamShape(shape) {
  webcamLive.classList.remove('shape-circle', 'shape-square', 'shape-rect');
  webcamLive.classList.add(`shape-${shape}`);
}

// "Priming" helper: tries getUserMedia in the popup. If permission was already
// granted (via permissions.html page), this succeeds silently — no prompt.
// If not granted, the popup can't show a prompt so it fails → we show the hint.
async function primeMediaAccess(type) {
  try {
    const constraints = type === 'audio' ? { audio: true } : { video: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach(t => t.stop());
    return true; // permission is granted
  } catch (e) {
    console.log(`[site2gif] primeMediaAccess("${type}") failed:`, e.name);
    return false; // permission not yet granted
  }
}

async function enumerateAudioDevices() {
  console.log('[site2gif] enumerateAudioDevices()');
  micSelect.innerHTML = '<option value="">None</option>';

  const granted = await primeMediaAccess('audio');
  if (!granted) {
    console.log('[site2gif] Mic permission not granted → showing hint');
    micPermHint.classList.add('show');
    updatePermHintsRow();
    return;
  }

  micPermHint.classList.remove('show');
  updatePermHintsRow();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== '');
    console.log(`[site2gif] Found ${mics.length} mics`);
    mics.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      micSelect.appendChild(opt);
    });
    console.log(`[site2gif] Mic dropdown: ${micSelect.options.length} options`);
  } catch (e) {
    console.error('[site2gif] enumerateDevices failed:', e);
  }
}

async function enumerateCameraDevices() {
  console.log('[site2gif] enumerateCameraDevices()');
  webcamSelect.innerHTML = '<option value="">None</option>';

  const granted = await primeMediaAccess('video');
  if (!granted) {
    console.log('[site2gif] Camera permission not granted → showing hint');
    camPermHint.classList.add('show');
    updatePermHintsRow();
    return;
  }

  camPermHint.classList.remove('show');
  updatePermHintsRow();
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput' && d.deviceId && d.deviceId !== '');
    console.log(`[site2gif] Found ${cams.length} cameras`);
    cams.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      webcamSelect.appendChild(opt);
    });
    console.log(`[site2gif] Camera dropdown: ${webcamSelect.options.length} options`);
  } catch (e) {
    console.error('[site2gif] enumerateDevices failed:', e);
  }
}

// ─── Webcam Preview ───

async function startWebcamPreview(deviceId) {
  console.log(`[site2gif] startWebcamPreview("${deviceId ? deviceId.slice(0,12) + '...' : ''}")`);
  stopWebcamPreview();
  if (!deviceId) { webcamLive.style.display = 'none'; return; }
  try {
    console.log('[site2gif] Requesting webcam stream with ideal deviceId...');
    webcamPreviewStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { ideal: deviceId }, width: { ideal: 320 }, height: { ideal: 240 } }
    });
    console.log(`[site2gif] Webcam stream obtained: ${webcamPreviewStream.getVideoTracks().length} video track(s)`);
    webcamLive.srcObject = webcamPreviewStream;
    webcamLive.style.display = '';
    console.log('[site2gif] Webcam preview element updated and visible');
  } catch (e) {
    console.error('[site2gif] Webcam preview failed:', e.name, e.message);
    webcamLive.style.display = 'none';
    // Fallback: try without specific device
    try {
      console.log('[site2gif] Trying fallback webcam (no specific device)...');
      webcamPreviewStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 } }
      });
      console.log('[site2gif] Fallback webcam stream obtained');
      webcamLive.srcObject = webcamPreviewStream;
      webcamLive.style.display = '';
    } catch (e2) {
      console.error('[site2gif] Webcam fallback also failed:', e2.name, e2.message);
    }
  }
}

function stopWebcamPreview() {
  if (webcamPreviewStream) {
    webcamPreviewStream.getTracks().forEach(t => t.stop());
    webcamPreviewStream = null;
  }
  webcamLive.srcObject = null;
  webcamLive.style.display = 'none';
}

function updateWebcamPipPosition(pos) {
  webcamLive.classList.remove('pos-TL', 'pos-TR', 'pos-BL', 'pos-BR');
  webcamLive.classList.add('pos-' + pos);
}

// ─── Mic Level Monitor ───

function createMicBars() {
  if (!micLevel) return;
  micLevel.innerHTML = '';
  for (let i = 0; i < MIC_BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'mic-bar';
    micLevel.appendChild(bar);
  }
}

async function startMicMonitor(deviceId) {
  console.log(`[site2gif] startMicMonitor("${deviceId ? deviceId.slice(0,12) + '...' : ''}")`);
  stopMicMonitor();
  if (!deviceId) return;

  try {
    console.log('[site2gif] Requesting mic monitor stream...');
    micMonitorStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { ideal: deviceId } }
    });
    console.log(`[site2gif] Mic monitor stream obtained: ${micMonitorStream.getAudioTracks().length} audio track(s)`);

    micMonitorCtx = new AudioContext();
    const source = micMonitorCtx.createMediaStreamSource(micMonitorStream);
    micMonitorAnalyser = micMonitorCtx.createAnalyser();
    micMonitorAnalyser.fftSize = 64;
    micMonitorAnalyser.smoothingTimeConstant = 0.65;
    source.connect(micMonitorAnalyser);
    // Don't connect to destination — we don't want to hear ourselves

    micLevel.classList.add('active');

    const bars = micLevel.querySelectorAll('.mic-bar');
    const dataArray = new Uint8Array(micMonitorAnalyser.frequencyBinCount);
    const barCount = bars.length;

    function tick() {
      micMonitorAnalyser.getByteFrequencyData(dataArray);
      const step = Math.max(1, Math.floor(dataArray.length / barCount));
      for (let i = 0; i < barCount; i++) {
        const val = dataArray[Math.min(i * step, dataArray.length - 1)] / 255;
        const h = Math.max(2, Math.round(val * 24));
        bars[i].style.height = h + 'px';
      }
      micMonitorRAF = requestAnimationFrame(tick);
    }
    tick();
  } catch (e) {
    console.warn('Mic monitor failed:', e);
    micLevel.classList.remove('active');
  }
}

function stopMicMonitor() {
  if (micMonitorRAF) { cancelAnimationFrame(micMonitorRAF); micMonitorRAF = null; }
  if (micMonitorStream) { micMonitorStream.getTracks().forEach(t => t.stop()); micMonitorStream = null; }
  if (micMonitorCtx) { micMonitorCtx.close().catch(() => {}); micMonitorCtx = null; }
  micMonitorAnalyser = null;
  if (micLevel) {
    micLevel.classList.remove('active');
    micLevel.querySelectorAll('.mic-bar').forEach(b => { b.style.height = '2px'; });
  }
}

// ─── GIF Generation ───

async function generateAndSaveGif() {
  if (isGeneratingGif) return;
  isGeneratingGif = true;
  updateSaveButton();
  progressSection.style.display = '';
  progressFill.style.width = '0%';
  progressLabel.textContent = '0%';

  try {
    const videoBlob = await Site2GifDB.get('video');
    if (!videoBlob) throw new Error('No recording found');

    const settings = currentState?.settings || {};
    const { fps = 10, scale = 1, quality = 'medium', loop = true } = settings;
    const wcPos = settings.webcamPosition || 'BR';
    const wcShape = settings.webcamShape || 'rect';

    const video = $('#gifSourceVideo');
    const url = URL.createObjectURL(videoBlob);
    video.src = url;
    await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = fail; video.load(); });
    if (video.readyState < 2) await new Promise(r => { video.oncanplay = r; });

    // Load webcam recording for compositing
    let wcVideo = null, wcUrl = null;
    try {
      const wcBlob = await Site2GifDB.get('webcam');
      if (wcBlob) {
        wcVideo = document.createElement('video');
        wcVideo.muted = true;
        wcUrl = URL.createObjectURL(wcBlob);
        wcVideo.src = wcUrl;
        await new Promise(r => { wcVideo.onloadeddata = r; wcVideo.load(); });
        if (wcVideo.readyState < 2) await new Promise(r => { wcVideo.oncanplay = r; });
      }
    } catch (e) { console.warn('Webcam load for GIF failed:', e); }

    let outW = Math.round(video.videoWidth * scale);
    let outH = Math.round(video.videoHeight * scale);
    outW = Math.max(2, outW & ~1);
    outH = Math.max(2, outH & ~1);

    const canvas = $('#gifCanvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let dur = video.duration;
    if (!isFinite(dur)) {
      if (currentState?.duration > 0 && isFinite(currentState.duration)) {
        dur = currentState.duration;
      } else {
        video.currentTime = 1e10;
        await new Promise(r => { video.onseeked = r; setTimeout(r, 3000); });
        dur = video.currentTime;
        video.currentTime = 0;
        await new Promise(r => { video.onseeked = r; setTimeout(r, 1000); });
      }
    }
    if (!isFinite(dur) || dur <= 0) throw new Error('Could not determine duration');

    const clipStart = trimStart * dur;
    const clipEnd = trimEnd * dur;
    const clipDur = clipEnd - clipStart;
    const interval = 1 / fps;
    const totalFrames = Math.max(1, Math.floor(clipDur * fps));

    const frames = [];
    for (let i = 0; i < totalFrames; i++) {
      const t = Math.min(clipStart + i * interval, clipEnd - 0.001);
      await seekVideo(video, t);
      if (wcVideo) await seekVideo(wcVideo, t);
      ctx.drawImage(video, 0, 0, outW, outH);
      if (wcVideo && wcVideo.readyState >= 2) {
        drawWebcamPIP(ctx, wcVideo, outW, outH, wcPos, wcShape);
      }
      frames.push(ctx.getImageData(0, 0, outW, outH).data.buffer);
      const pct = Math.round(((i + 1) / totalFrames) * 40);
      progressFill.style.width = pct + '%';
      progressLabel.textContent = pct + '%';
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
    }
    URL.revokeObjectURL(url);
    if (wcUrl) URL.revokeObjectURL(wcUrl);

    const gifData = await encodeGifInWorker(frames, outW, outH, fps, quality, loop);
    const gifBlob = new Blob([gifData], { type: 'image/gif' });
    await Site2GifDB.put('gif', gifBlob);
    gifIsReady = true;

    progressFill.style.width = '100%';
    progressLabel.textContent = fmtSize(gifBlob.size);
    updateSaveButton();
    previewTabs.style.display = '';
    triggerDownload(gifBlob, `site2gif-${ts()}.gif`);
    setTimeout(() => { progressSection.style.display = 'none'; }, 1500);
  } catch (e) {
    console.error('GIF generation failed:', e);
    progressLabel.textContent = 'Error';
    setTimeout(() => { progressSection.style.display = 'none'; }, 3000);
  } finally {
    isGeneratingGif = false;
    updateSaveButton();
  }
}

function seekVideo(video, time) {
  return new Promise(r => {
    if (Math.abs(video.currentTime - time) < 0.02) { r(); return; }
    const done = () => { video.removeEventListener('seeked', done); r(); };
    video.addEventListener('seeked', done);
    video.currentTime = time;
    setTimeout(() => { video.removeEventListener('seeked', done); r(); }, 2000);
  });
}

function encodeGifInWorker(frames, w, h, fps, quality, loop) {
  return new Promise((resolve, reject) => {
    if (gifWorker) gifWorker.terminate();
    gifWorker = new Worker('gif-worker.js');
    gifWorker.onmessage = (e) => {
      if (e.data.type === 'progress') {
        const pct = Math.round(40 + e.data.value * 60);
        progressFill.style.width = pct + '%';
        progressLabel.textContent = pct + '%';
      } else if (e.data.type === 'done') {
        gifWorker.terminate(); gifWorker = null;
        resolve(e.data.data);
      }
    };
    gifWorker.onerror = (e) => { gifWorker.terminate(); gifWorker = null; reject(e); };
    gifWorker.postMessage({ frames, width: w, height: h, fps, quality, loop }, frames.slice());
  });
}

// ─── Trim ───

function updateTrimUI() {
  const sp = trimStart * 100, ep = trimEnd * 100;
  trimRange.style.left = sp + '%';
  trimRange.style.right = (100 - ep) + '%';
  trimHandleStart.style.left = `calc(${sp}% - 8px)`;
  trimHandleEnd.style.left = `calc(${ep}% - 8px)`;
  const ss = trimStart * videoDuration, es = trimEnd * videoDuration;
  trimStartTime.textContent = fmtPrecise(ss);
  trimEndTime.textContent = fmtPrecise(es);
  trimSelectionLabel.textContent = (trimStart === 0 && trimEnd === 1)
    ? 'Full clip' : fmtPrecise(es - ss) + ' selected';
}

function initTrimDrag() {
  let dragging = null;
  const pctOf = (e) => {
    const r = trimTrack.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  trimHandleStart.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    dragging = 'start'; trimHandleStart.classList.add('dragging');
    trimHandleStart.setPointerCapture(e.pointerId);
  });
  trimHandleEnd.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    dragging = 'end'; trimHandleEnd.classList.add('dragging');
    trimHandleEnd.setPointerCapture(e.pointerId);
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = pctOf(e);
    if (dragging === 'start') trimStart = Math.min(p, trimEnd - 0.01);
    else trimEnd = Math.max(p, trimStart + 0.01);
    if (gifIsReady) { gifIsReady = false; updateSaveButton(); previewTabs.style.display = 'none'; }
    updateTrimUI();
    if (previewVideo.src && videoDuration > 0)
      previewVideo.currentTime = (dragging === 'start' ? trimStart : trimEnd) * videoDuration;
  });
  document.addEventListener('pointerup', () => {
    if (!dragging) return;
    trimHandleStart.classList.remove('dragging');
    trimHandleEnd.classList.remove('dragging');
    dragging = null;
    if (previewVideo.src && videoDuration > 0 && activePreviewTab === 'video') {
      previewVideo.currentTime = trimStart * videoDuration;
      previewVideo.play().catch(() => {});
    }
  });
  trimTrack.addEventListener('click', (e) => {
    if (e.target === trimHandleStart || e.target === trimHandleEnd) return;
    if (previewVideo.src && videoDuration > 0) {
      previewVideo.currentTime = pctOf(e) * videoDuration;
      previewVideo.play().catch(() => {});
    }
  });
}

function startPlayheadTracker() {
  stopPlayheadTracker();
  (function tick() {
    if (previewVideo && videoDuration > 0 && !previewVideo.paused) {
      trimPlayhead.style.left = (previewVideo.currentTime / videoDuration) * 100 + '%';
      if (previewVideo.currentTime >= trimEnd * videoDuration) {
        previewVideo.currentTime = trimStart * videoDuration;
        if (doneWebcam.src) doneWebcam.currentTime = trimStart * videoDuration;
      }
    }
    playheadRAF = requestAnimationFrame(tick);
  })();
}

function stopPlayheadTracker() {
  if (playheadRAF) { cancelAnimationFrame(playheadRAF); playheadRAF = null; }
}

// ─── Timer ───

function startTimer() {
  if (timerInterval) return;
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 200);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}
function updateTimerDisplay() {
  if (!currentState?.startTime) return;
  recTimer.textContent = fmtDur((Date.now() - currentState.startTime) / 1000);
}

// ─── Settings Sync ───

function syncSettings(s) {
  if (!s) return;
  $$('#fpsGroup .opt-pill').forEach(p => p.classList.toggle('active', p.dataset.value === String(s.fps)));
  $$('#scaleGroup .opt-pill').forEach(p => p.classList.toggle('active', p.dataset.value === String(s.scale)));
  $$('#qualityGroup .opt-pill').forEach(p => p.classList.toggle('active', p.dataset.value === s.quality));
  $('#showCursor').checked = s.showCursor;
  $('#loopGif').checked = s.loop;
  $('#audioEnabled').checked = s.audioEnabled;
  $('#webcamEnabled').checked = s.webcamEnabled;

  // Expand panels if enabled
  audioPanel.style.display = s.audioEnabled ? '' : 'none';
  webcamPanel.style.display = s.webcamEnabled ? '' : 'none';

  // Enumerate and select saved devices (only auto-select if permission is granted)
  if (s.audioEnabled) {
    enumerateAudioDevices().then(() => {
      if (micPermHint.classList.contains('show')) return; // no permission yet
      if (s.micDeviceId && micSelect.querySelector(`option[value="${CSS.escape(s.micDeviceId)}"]`)) {
        micSelect.value = s.micDeviceId;
        startMicMonitor(s.micDeviceId);
      } else if (micSelect.options.length > 1) {
        const firstId = micSelect.options[1].value;
        micSelect.value = firstId;
        updateSetting('micDeviceId', firstId);
        startMicMonitor(firstId);
      }
    });
  }
  if (s.webcamEnabled) {
    enumerateCameraDevices().then(() => {
      if (camPermHint.classList.contains('show')) return; // no permission yet
      if (s.webcamDeviceId && webcamSelect.querySelector(`option[value="${CSS.escape(s.webcamDeviceId)}"]`)) {
        webcamSelect.value = s.webcamDeviceId;
        startWebcamPreview(s.webcamDeviceId);
      } else if (webcamSelect.options.length > 1) {
        const firstId = webcamSelect.options[1].value;
        webcamSelect.value = firstId;
        updateSetting('webcamDeviceId', firstId);
        startWebcamPreview(firstId);
      }
    });
  }

  // Position picker
  $$('.pos-dot').forEach(b => b.classList.toggle('active', b.dataset.pos === (s.webcamPosition || 'BR')));
  updateWebcamPipPosition(s.webcamPosition || 'BR');

  // Shape picker
  $$('#shapeGroup .shape-btn').forEach(p => p.classList.toggle('active', p.dataset.value === (s.webcamShape || 'rect')));
  updateWebcamShape(s.webcamShape || 'rect');
}

function updateSetting(key, value) {
  msg('update-settings', { settings: { [key]: value } });
}

// ─── Events ───

function setupListeners() {
  // Record / Stop
  recordBtn.addEventListener('click', () => {
    if (currentState?.status === 'recording') msg('stop-recording');
    else msg('start-recording');
  });

  // Cursor toggle
  $('#showCursor').addEventListener('change', (e) => updateSetting('showCursor', e.target.checked));

  // ── Audio toggle ──
  $('#audioEnabled').addEventListener('change', async (e) => {
    const on = e.target.checked;
    updateSetting('audioEnabled', on);
    audioPanel.style.display = on ? '' : 'none';
    if (on) {
      await enumerateAudioDevices();
      if (!micPermHint.classList.contains('show') && micSelect.options.length > 1 && !micSelect.value) {
        const firstId = micSelect.options[1].value;
        micSelect.value = firstId;
        updateSetting('micDeviceId', firstId);
        startMicMonitor(firstId);
      }
    } else {
      stopMicMonitor();
      micPermHint.classList.remove('show');
      updatePermHintsRow();
    }
  });

  // Mic device change
  micSelect.addEventListener('change', () => {
    const id = micSelect.value;
    updateSetting('micDeviceId', id);
    if (id) startMicMonitor(id);
    else stopMicMonitor();
  });

  // Mic permission hint → open permissions page in a real tab
  micPermHint.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html?type=audio') });
  });

  // ── Webcam toggle ──
  $('#webcamEnabled').addEventListener('change', async (e) => {
    const on = e.target.checked;
    updateSetting('webcamEnabled', on);
    webcamPanel.style.display = on ? '' : 'none';
    if (on) {
      await enumerateCameraDevices();
      if (!camPermHint.classList.contains('show') && webcamSelect.options.length > 1 && !webcamSelect.value) {
        const firstId = webcamSelect.options[1].value;
        webcamSelect.value = firstId;
        updateSetting('webcamDeviceId', firstId);
        startWebcamPreview(firstId);
      }
    } else {
      stopWebcamPreview();
      camPermHint.classList.remove('show');
      updatePermHintsRow();
    }
  });

  // Camera device change
  webcamSelect.addEventListener('change', () => {
    const id = webcamSelect.value;
    updateSetting('webcamDeviceId', id);
    if (id) startWebcamPreview(id);
    else stopWebcamPreview();
  });

  // Camera permission hint → open permissions page in a real tab
  camPermHint.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('permissions.html?type=video') });
  });

  // Handle permission granted messages (from permissions page via background)
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'permissions-granted') {
      console.log(`[site2gif] Permission granted for: ${m.mediaType}`);
      // Re-enumerate when popup re-opens — the message might arrive
      // while popup is still open if user keeps it open somehow
      if (m.mediaType === 'audio' || m.mediaType === 'both') {
        enumerateAudioDevices().then(() => {
          if (!micPermHint.classList.contains('show') && micSelect.options.length > 1 && !micSelect.value) {
            const firstId = micSelect.options[1].value;
            micSelect.value = firstId;
            updateSetting('micDeviceId', firstId);
            startMicMonitor(firstId);
          }
        });
      }
      if (m.mediaType === 'video' || m.mediaType === 'both') {
        enumerateCameraDevices().then(() => {
          if (!camPermHint.classList.contains('show') && webcamSelect.options.length > 1 && !webcamSelect.value) {
            const firstId = webcamSelect.options[1].value;
            webcamSelect.value = firstId;
            updateSetting('webcamDeviceId', firstId);
            startWebcamPreview(firstId);
          }
        });
      }
    }
  });

  // Position picker
  $$('.pos-dot').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.pos-dot').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const pos = btn.dataset.pos;
      updateSetting('webcamPosition', pos);
      updateWebcamPipPosition(pos);
    });
  });

  // Shape picker
  $$('#shapeGroup .shape-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#shapeGroup .shape-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const shape = btn.dataset.value;
      updateSetting('webcamShape', shape);
      updateWebcamShape(shape);
    });
  });

  // GIF settings pills
  setupPillGroup('fpsGroup', 'fps', parseInt);
  setupPillGroup('scaleGroup', 'scale', parseFloat);
  setupPillGroup('qualityGroup', 'quality', String);
  $('#loopGif').addEventListener('change', (e) => updateSetting('loop', e.target.checked));

  // Format toggle
  $$('.format-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.format-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedFormat = btn.dataset.format;
      gifOpts.style.display = selectedFormat === 'gif' ? '' : 'none';
      videoInfo.style.display = selectedFormat === 'video' ? '' : 'none';
      updateSaveButton();
    });
  });

  // Unified save
  saveBtn.addEventListener('click', async () => {
    if (selectedFormat === 'gif') {
      if (gifIsReady) {
        const b = await Site2GifDB.get('gif');
        if (b) triggerDownload(b, `site2gif-${ts()}.gif`);
      } else {
        generateAndSaveGif();
      }
    } else {
      const blob = await Site2GifDB.get('video');
      if (!blob) return;
      const wcBlob = await Site2GifDB.get('webcam');
      // Only skip compositing if no webcam AND no trim
      if (!wcBlob && trimStart === 0 && trimEnd === 1) {
        triggerDownload(blob, `site2gif-${ts()}.webm`);
        return;
      }
      try {
        saveBtn.disabled = true;
        saveBtnText.textContent = wcBlob ? 'Compositing...' : 'Trimming...';
        saveBtnSize.textContent = '';
        const exported = await exportVideo(blob, wcBlob);
        triggerDownload(exported, `site2gif-${ts()}.webm`);
      } catch (e) { console.error('Export failed:', e); }
      finally { updateSaveButton(); }
    }
  });

  // Preview VID / GIF toggle
  $$('.mode-pill').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.mode-pill').forEach(t => t.classList.remove('active'));
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
    if (doneWebcamUrl) { URL.revokeObjectURL(doneWebcamUrl); doneWebcamUrl = null; }
    if (gifWorker) { gifWorker.terminate(); gifWorker = null; }
    previewVideo.src = '';
    previewGif.src = '';
    doneWebcam.src = '';
    doneWebcam.style.display = 'none';
    activePreviewTab = 'video';
    selectedFormat = 'gif';
    gifIsReady = false;
    isGeneratingGif = false;
    trimStart = 0; trimEnd = 1; videoDuration = 0;
    stopPlayheadTracker();
    $$('.mode-pill').forEach(t => t.classList.toggle('active', t.dataset.tab === 'video'));
    $$('.format-opt').forEach(b => b.classList.toggle('active', b.dataset.format === 'gif'));
    gifOpts.style.display = '';
    videoInfo.style.display = 'none';
    msg('clear');
  });

  // Trim drag
  initTrimDrag();

  // State updates
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'state-update') render(m.state);
  });
}

function setupPillGroup(groupId, key, parse) {
  $$(`#${groupId} .opt-pill`).forEach(pill => {
    pill.addEventListener('click', () => {
      $$(`#${groupId} .opt-pill`).forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      updateSetting(key, parse(pill.dataset.value));
    });
  });
}

// ─── Video Export (trim + webcam compositing) ───

async function exportVideo(videoBlob, webcamBlob) {
  // Create elements DYNAMICALLY and append to DOM with off-screen positioning.
  // The DOM #gifSourceVideo and #gifCanvas have display:none which breaks
  // captureStream() in Chrome. Elements must be in the DOM (not display:none)
  // for captureStream to produce correct frames.
  const offscreen = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = offscreen;
  document.body.appendChild(video);

  const url = URL.createObjectURL(videoBlob);
  video.src = url;
  await new Promise(r => { video.onloadeddata = r; video.load(); });
  if (video.readyState < 2) await new Promise(r => { video.oncanplay = r; });

  // Load webcam video for compositing
  let wcVideo = null, wcUrl = null;
  if (webcamBlob) {
    wcVideo = document.createElement('video');
    wcVideo.muted = true;
    wcVideo.playsInline = true;
    wcVideo.style.cssText = offscreen;
    document.body.appendChild(wcVideo);
    wcUrl = URL.createObjectURL(webcamBlob);
    wcVideo.src = wcUrl;
    await new Promise(r => { wcVideo.onloadeddata = r; wcVideo.load(); });
    if (wcVideo.readyState < 2) await new Promise(r => { wcVideo.oncanplay = r; });
  }

  // Create canvas and append to DOM (NOT display:none — captureStream needs it)
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.style.cssText = offscreen;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  console.log(`[site2gif] Export: canvas=${canvas.width}x${canvas.height}, video=${video.videoWidth}x${video.videoHeight}`);

  const canvasStream = canvas.captureStream(30);

  // Preserve audio in export by capturing from source video
  try {
    const sourceStream = video.captureStream();
    sourceStream.getAudioTracks().forEach(t => canvasStream.addTrack(t));
  } catch (e) { console.warn('Audio capture for export unavailable:', e); }

  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
  const rec = new MediaRecorder(canvasStream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

  const startSec = trimStart * videoDuration;
  const endSec = trimEnd * videoDuration;
  video.currentTime = startSec;
  if (wcVideo) wcVideo.currentTime = startSec;
  await new Promise(r => { video.onseeked = r; setTimeout(r, 2000); });
  if (wcVideo) await new Promise(r => { wcVideo.onseeked = r; setTimeout(r, 2000); });

  const settings = currentState?.settings || {};
  const pos = settings.webcamPosition || 'BR';
  const shape = settings.webcamShape || 'rect';

  function cleanupExportElements() {
    URL.revokeObjectURL(url);
    if (wcUrl) URL.revokeObjectURL(wcUrl);
    if (video.parentNode) video.parentNode.removeChild(video);
    if (wcVideo && wcVideo.parentNode) wcVideo.parentNode.removeChild(wcVideo);
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  return new Promise((resolve, reject) => {
    rec.onstop = () => {
      cleanupExportElements();
      resolve(new Blob(chunks, { type: mime }));
    };
    rec.onerror = (e) => {
      cleanupExportElements();
      reject(e);
    };
    rec.start(100);
    video.play();
    if (wcVideo) wcVideo.play().catch(() => {});
    (function draw() {
      if (video.currentTime >= endSec || video.ended) {
        video.pause();
        if (wcVideo) wcVideo.pause();
        rec.stop();
        return;
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (wcVideo && wcVideo.readyState >= 2) {
        drawWebcamPIP(ctx, wcVideo, canvas.width, canvas.height, pos, shape);
      }
      requestAnimationFrame(draw);
    })();
  });
}

// ─── Webcam PIP Drawing (shared by video export + GIF generation) ───

function drawWebcamPIP(ctx, wcVideo, W, H, position, shape) {
  const baseSize = Math.round(W * 0.2);
  let pipW, pipH;
  if (shape === 'circle' || shape === 'square') {
    pipW = pipH = baseSize;
  } else {
    pipW = baseSize;
    pipH = Math.round(baseSize * wcVideo.videoHeight / (wcVideo.videoWidth || 1));
  }

  const m = 12;
  let x, y;
  switch (position) {
    case 'TL': x = m; y = m; break;
    case 'TR': x = W - pipW - m; y = m; break;
    case 'BL': x = m; y = H - pipH - m; break;
    default:   x = W - pipW - m; y = H - pipH - m; break;
  }

  ctx.save();
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.arc(x + pipW / 2, y + pipH / 2, pipW / 2, 0, Math.PI * 2);
    ctx.closePath();
  } else {
    const r = 8;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + pipW - r, y);
    ctx.quadraticCurveTo(x + pipW, y, x + pipW, y + r);
    ctx.lineTo(x + pipW, y + pipH - r);
    ctx.quadraticCurveTo(x + pipW, y + pipH, x + pipW - r, y + pipH);
    ctx.lineTo(x + r, y + pipH);
    ctx.quadraticCurveTo(x, y + pipH, x, y + pipH - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  ctx.clip();

  // Cover-style crop
  const vw = wcVideo.videoWidth, vh = wcVideo.videoHeight;
  const pipAR = pipW / pipH, videoAR = vw / (vh || 1);
  let sx, sy, sw, sh;
  if (videoAR > pipAR) {
    sh = vh; sw = Math.round(vh * pipAR);
    sx = Math.round((vw - sw) / 2); sy = 0;
  } else {
    sw = vw; sh = Math.round(vw / pipAR);
    sx = 0; sy = Math.round((vh - sh) / 2);
  }
  ctx.drawImage(wcVideo, sx, sy, sw, sh, x, y, pipW, pipH);
  ctx.restore();

  // Border
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.arc(x + pipW / 2, y + pipH / 2, pipW / 2, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const r = 8;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + pipW - r, y);
    ctx.quadraticCurveTo(x + pipW, y, x + pipW, y + r);
    ctx.lineTo(x + pipW, y + pipH - r);
    ctx.quadraticCurveTo(x + pipW, y + pipH, x + pipW - r, y + pipH);
    ctx.lineTo(x + r, y + pipH);
    ctx.quadraticCurveTo(x, y + pipH, x, y + pipH - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.stroke();
  }
}

// ─── Helpers ───

function triggerDownload(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fmtDur(s) {
  return Math.floor(s / 60).toString().padStart(2, '0') + ':' +
    Math.floor(s % 60).toString().padStart(2, '0');
}
function fmtPrecise(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${sec.toFixed(1).padStart(4, '0')}` : sec.toFixed(1) + 's';
}
function ts() {
  const d = new Date();
  return [d.getFullYear(), (d.getMonth()+1).toString().padStart(2,'0'),
    d.getDate().toString().padStart(2,'0'), '-',
    d.getHours().toString().padStart(2,'0'),
    d.getMinutes().toString().padStart(2,'0'),
    d.getSeconds().toString().padStart(2,'0')].join('');
}

// Cleanup on popup close
window.addEventListener('unload', () => {
  stopWebcamPreview();
  stopMicMonitor();
  stopPlayheadTracker();
  if (gifWorker) { gifWorker.terminate(); gifWorker = null; }
  if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
  if (gifObjectUrl) URL.revokeObjectURL(gifObjectUrl);
  if (doneWebcamUrl) URL.revokeObjectURL(doneWebcamUrl);
});

init();
