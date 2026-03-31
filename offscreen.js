// site2gif — Offscreen Document
// Records tab capture with optional mic audio mixing.
// Webcam is recorded as a SEPARATE stream and stored independently.
// Webcam compositing happens in the popup (visible document) during export,
// because canvas.captureStream() is broken in hidden/offscreen documents
// (Chromium bugs #41270855, #41279417).

console.log('[site2gif] Offscreen loaded — v2 (raw streams, no canvas compositing)');

let mediaRecorder = null;
let recordedChunks = [];
let webcamRecorder = null;
let webcamChunks = [];
let tabStream = null;
let micStream = null;
let webcamStream = null;
let audioContext = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'start-capture': startCapture(msg); break;
    case 'stop-capture': stopCapture(); break;
    case 'clear': cleanup(); break;
  }
  return false;
});

async function startCapture(config) {
  const { streamId, audioEnabled, micDeviceId, webcamEnabled, webcamDeviceId, tabWidth, tabHeight } = config;

  try {
    // 1. Tab stream (video + optional tab audio)
    // Use tab dimensions passed from the service worker to ensure the capture
    // matches the tab's actual viewport — not a Chrome default.
    const videoConstraints = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    };
    if (config.tabWidth && config.tabHeight) {
      videoConstraints.mandatory.minWidth = config.tabWidth;
      videoConstraints.mandatory.minHeight = config.tabHeight;
      videoConstraints.mandatory.maxWidth = config.tabWidth;
      videoConstraints.mandatory.maxHeight = config.tabHeight;
    }
    tabStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioEnabled
        ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
        : false
    });

    // 2. Microphone (optional)
    micStream = null;
    if (micDeviceId) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { ideal: micDeviceId } }
        });
      } catch (e) { console.warn('Mic access failed:', e); }
    }

    // 3. Webcam (optional) — recorded separately, composited in popup during export
    webcamStream = null;
    if (webcamEnabled && webcamDeviceId) {
      try {
        webcamStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { ideal: webcamDeviceId }, width: { ideal: 320 }, height: { ideal: 240 } }
        });
      } catch (e) {
        console.warn('Webcam access failed, trying default:', e);
        try {
          webcamStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 320 }, height: { ideal: 240 } }
          });
        } catch (e2) { console.warn('Default webcam also failed:', e2); }
      }
    }

    // 4. Build recording stream — tab video + mixed audio (NO canvas compositing)
    const videoTracks = tabStream.getVideoTracks();
    const vSettings = videoTracks[0]?.getSettings();
    console.log(`[site2gif] Tab requested: ${tabWidth}x${tabHeight}, captured: ${vSettings?.width}x${vSettings?.height}, webcam=${!!webcamStream}`);
    const audioTrack = mixAudio(tabStream, micStream);

    const recordStream = new MediaStream(videoTracks);
    if (audioTrack) recordStream.addTrack(audioTrack);

    // 5. Start tab recording
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';

    mediaRecorder = new MediaRecorder(recordStream, { mimeType, videoBitsPerSecond: 5_000_000 });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = finalizeRecording;

    // 6. Start webcam recording separately (if available)
    if (webcamStream) {
      webcamChunks = [];
      const wcMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8' : 'video/webm';
      webcamRecorder = new MediaRecorder(webcamStream, { mimeType: wcMime, videoBitsPerSecond: 500_000 });
      webcamRecorder.ondataavailable = (e) => { if (e.data.size > 0) webcamChunks.push(e.data); };
      webcamRecorder.start(100);
    }

    mediaRecorder.start(100);
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'error', error: e.message });
  }
}

// ─── Audio Mixing ───

function mixAudio(tab, mic) {
  const tabAudio = tab.getAudioTracks();
  const micAudio = mic ? mic.getAudioTracks() : [];

  if (!tabAudio.length && !micAudio.length) return null;
  if (tabAudio.length && !micAudio.length) return tabAudio[0];
  if (!tabAudio.length && micAudio.length) return micAudio[0];

  // Mix both sources via Web Audio API
  audioContext = new AudioContext();
  const dest = audioContext.createMediaStreamDestination();
  audioContext.createMediaStreamSource(new MediaStream(tabAudio)).connect(dest);
  audioContext.createMediaStreamSource(new MediaStream(micAudio)).connect(dest);
  return dest.stream.getAudioTracks()[0];
}

// ─── Finalize ───

async function finalizeRecording() {
  // Collect webcam recording if it's still running
  if (webcamRecorder && webcamRecorder.state !== 'inactive') {
    await new Promise(r => {
      webcamRecorder.addEventListener('stop', r, { once: true });
      webcamRecorder.stop();
    });
  }

  const mimeType = mediaRecorder?.mimeType || 'video/webm';
  stopAllStreams();

  const videoBlob = new Blob(recordedChunks, { type: mimeType });
  recordedChunks = [];

  try { await Site2GifDB.put('video', videoBlob); } catch (e) { console.error('DB store failed:', e); }

  // Store webcam recording separately
  if (webcamChunks.length > 0) {
    const wcBlob = new Blob(webcamChunks, { type: 'video/webm' });
    webcamChunks = [];
    try { await Site2GifDB.put('webcam', wcBlob); } catch (e) { console.error('Webcam DB store failed:', e); }
  }

  webcamRecorder = null;
  chrome.runtime.sendMessage({ type: 'recording-ready', videoSize: videoBlob.size });
}

// ─── Cleanup ───

function stopCapture() {
  if (webcamRecorder && webcamRecorder.state !== 'inactive') webcamRecorder.stop();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

function stopAllStreams() {
  if (tabStream) { tabStream.getTracks().forEach(t => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
}

async function cleanup() {
  stopCapture();
  stopAllStreams();
  recordedChunks = [];
  webcamChunks = [];
  try { await Site2GifDB.clear(); } catch (e) {}
}
