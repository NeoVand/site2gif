// site2gif — Offscreen Document
// Only handles recording. GIF generation is done in the popup.
// Stores video blob in IndexedDB (shared with popup via db.js).

let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'start-capture':
      startCapture(msg.streamId);
      break;
    case 'stop-capture':
      stopCapture();
      break;
    case 'clear':
      cleanup();
      break;
  }
  return false;
});

async function startCapture(streamId) {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      audio: false
    });

    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm;codecs=vp8';

    mediaRecorder = new MediaRecorder(mediaStream, {
      mimeType,
      videoBitsPerSecond: 5_000_000
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
      }

      const videoBlob = new Blob(recordedChunks, { type: mimeType });
      recordedChunks = [];

      // Store video blob in IndexedDB (popup reads it directly)
      try {
        await Site2GifDB.put('video', videoBlob);
      } catch (e) {
        console.error('Failed to store video:', e);
      }

      chrome.runtime.sendMessage({
        type: 'recording-ready',
        videoSize: videoBlob.size
      });
    };

    mediaRecorder.start(100);
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'error', error: e.message });
  }
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

async function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  recordedChunks = [];
  try {
    await Site2GifDB.clear();
  } catch (e) {}
}
