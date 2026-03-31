// Talkover — Offscreen Document
// Records tab capture with optional mic audio (stored separately).
// Supports tab-switching during recording via segmented capture.
// Webcam is recorded as a SEPARATE stream and stored independently.

console.log('[Talkover] Offscreen loaded — v4 (segmented tab switching)');

let mediaRecorder = null;
let recordedChunks = [];
let videoSegments = [];       // Array of Blobs — one per tab segment
let webcamRecorder = null;
let webcamChunks = [];
let micRecorder = null;
let micChunks = [];
let tabStream = null;
let micStream = null;
let webcamStream = null;
let recordingHasTabAudio = false;
let recordingHasMic = false;
let isSwitchingTab = false;
let pendingSwitchConfig = null;
let recordingMimeType = '';

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'start-capture': startCapture(msg); break;
    case 'switch-tab': switchTab(msg); break;
    case 'stop-capture': stopCapture(); break;
    case 'clear': cleanup(); break;
  }
  return false;
});

async function startCapture(config) {
  const { streamId, audioEnabled, micDeviceId, webcamEnabled, webcamDeviceId, tabWidth, tabHeight } = config;

  try {
    // 1. Tab stream (video + optional tab audio)
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

    // 2. Microphone (optional) — recorded as SEPARATE blob, not mixed
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

    // 4. Start the first tab segment
    videoSegments = [];
    recordingHasTabAudio = tabStream.getAudioTracks().length > 0;
    recordingHasMic = !!micStream;
    startTabSegment(tabStream);

    // 5. Start webcam recording separately (if available)
    if (webcamStream) {
      webcamChunks = [];
      const wcMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
        ? 'video/webm;codecs=vp8' : 'video/webm';
      webcamRecorder = new MediaRecorder(webcamStream, { mimeType: wcMime, videoBitsPerSecond: 500_000 });
      webcamRecorder.ondataavailable = (e) => { if (e.data.size > 0) webcamChunks.push(e.data); };
      webcamRecorder.start(100);
    }

    // 6. Start mic recording separately (if available)
    if (micStream) {
      micChunks = [];
      const micMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : 'audio/webm';
      micRecorder = new MediaRecorder(micStream, { mimeType: micMime });
      micRecorder.ondataavailable = (e) => { if (e.data.size > 0) micChunks.push(e.data); };
      micRecorder.start(100);
    }
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'error', error: e.message });
  }
}

// Start recording a new tab segment from a given stream
function startTabSegment(stream) {
  const videoTracks = stream.getVideoTracks();
  const tabAudioTracks = stream.getAudioTracks();
  const vSettings = videoTracks[0]?.getSettings();
  console.log(`[Talkover] Segment ${videoSegments.length}: ${vSettings?.width}x${vSettings?.height}, audio=${tabAudioTracks.length > 0}`);

  if (tabAudioTracks.length > 0) recordingHasTabAudio = true;

  const recordStream = new MediaStream(videoTracks);
  if (tabAudioTracks.length > 0) recordStream.addTrack(tabAudioTracks[0]);

  recordedChunks = [];
  recordingMimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';

  mediaRecorder = new MediaRecorder(recordStream, {
    mimeType: recordingMimeType,
    videoBitsPerSecond: 5_000_000
  });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = onSegmentStop;
  mediaRecorder.start(100);
}

// Called when a segment's MediaRecorder stops (either tab switch or final stop)
function onSegmentStop() {
  if (recordedChunks.length > 0) {
    const segBlob = new Blob(recordedChunks, { type: recordingMimeType || 'video/webm' });
    videoSegments.push(segBlob);
    recordedChunks = [];
    console.log(`[Talkover] Saved segment ${videoSegments.length - 1}: ${(segBlob.size / 1024).toFixed(0)} KB`);
  }

  if (isSwitchingTab && pendingSwitchConfig) {
    // Continue recording on the new tab
    startNewTabCapture(pendingSwitchConfig);
    pendingSwitchConfig = null;
    isSwitchingTab = false;
  } else if (!isSwitchingTab) {
    // Final stop — finalize the whole recording
    finalizeRecording();
  }
}

// ─── Tab Switch ───

async function switchTab(config) {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

  isSwitchingTab = true;
  pendingSwitchConfig = config;

  // Stop old tab stream's tracks so Chrome releases the capture
  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }

  // Stop current recorder — onSegmentStop will save the segment and start new capture
  mediaRecorder.stop();
}

async function startNewTabCapture(config) {
  const { streamId, audioEnabled, tabWidth, tabHeight } = config;
  try {
    const videoConstraints = {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    };
    if (tabWidth && tabHeight) {
      videoConstraints.mandatory.minWidth = tabWidth;
      videoConstraints.mandatory.minHeight = tabHeight;
      videoConstraints.mandatory.maxWidth = tabWidth;
      videoConstraints.mandatory.maxHeight = tabHeight;
    }
    tabStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioEnabled
        ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
        : false
    });
    startTabSegment(tabStream);
  } catch (e) {
    console.error('New tab capture failed:', e);
    isSwitchingTab = false;
    // Recording is effectively stopped — finalize what we have
    finalizeRecording();
  }
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

  // Collect mic recording if it's still running
  if (micRecorder && micRecorder.state !== 'inactive') {
    await new Promise(r => {
      micRecorder.addEventListener('stop', r, { once: true });
      micRecorder.stop();
    });
  }

  const hasMic = micChunks.length > 0;
  const hasTabAudio = recordingHasTabAudio;
  stopAllStreams();

  // Store video segments
  let totalSize = 0;
  const segCount = videoSegments.length;
  if (videoSegments.length === 1) {
    // Single segment — store as plain 'video' blob (backward compatible)
    try { await TalkoverDB.put('video', videoSegments[0]); } catch (e) { console.error('DB store failed:', e); }
    totalSize = videoSegments[0].size;
  } else if (videoSegments.length > 1) {
    // Multiple segments — store each with indexed key + count
    for (let i = 0; i < videoSegments.length; i++) {
      try { await TalkoverDB.put(`video-seg-${i}`, videoSegments[i]); } catch (e) { console.error(`Segment ${i} store failed:`, e); }
      totalSize += videoSegments[i].size;
    }
    try { await TalkoverDB.put('video-seg-count', videoSegments.length); } catch (e) {}
    // Also store first segment as 'video' for preview compatibility
    try { await TalkoverDB.put('video', videoSegments[0]); } catch (e) {}
  }
  videoSegments = [];

  // Store webcam recording separately
  if (webcamChunks.length > 0) {
    const wcBlob = new Blob(webcamChunks, { type: 'video/webm' });
    webcamChunks = [];
    try { await TalkoverDB.put('webcam', wcBlob); } catch (e) { console.error('Webcam DB store failed:', e); }
  }

  // Store mic recording separately
  if (micChunks.length > 0) {
    const micBlob = new Blob(micChunks, { type: 'audio/webm' });
    micChunks = [];
    try { await TalkoverDB.put('mic', micBlob); } catch (e) { console.error('Mic DB store failed:', e); }
  }

  webcamRecorder = null;
  micRecorder = null;
  chrome.runtime.sendMessage({
    type: 'recording-ready',
    videoSize: totalSize,
    hasTabAudio,
    hasMic,
    segmentCount: segCount
  });
}

// ─── Cleanup ───

function stopCapture() {
  isSwitchingTab = false;
  pendingSwitchConfig = null;
  if (micRecorder && micRecorder.state !== 'inactive') micRecorder.stop();
  if (webcamRecorder && webcamRecorder.state !== 'inactive') webcamRecorder.stop();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

function stopAllStreams() {
  if (tabStream) { tabStream.getTracks().forEach(t => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (webcamStream) { webcamStream.getTracks().forEach(t => t.stop()); webcamStream = null; }
}

async function cleanup() {
  stopCapture();
  stopAllStreams();
  recordedChunks = [];
  videoSegments = [];
  webcamChunks = [];
  micChunks = [];
  try { await TalkoverDB.clear(); } catch (e) {}
}
