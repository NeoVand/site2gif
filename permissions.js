// Talkover — Permissions Page
// Opened in a tab so getUserMedia can properly show the browser permission prompt.
// Extension popups can't do this because the popup closes when the prompt appears.

const params = new URLSearchParams(location.search);
const mediaType = params.get('type') || 'audio'; // 'audio', 'video', or 'both'

const icon = document.getElementById('icon');
const title = document.getElementById('title');
const desc = document.getElementById('desc');
const status = document.getElementById('status');
const hint = document.getElementById('hint');

// Set up UI based on request type
const labels = {
  audio: { icon: '\uD83C\uDFA4', title: 'Microphone Access', name: 'microphone' },
  video: { icon: '\uD83D\uDCF7', title: 'Camera Access', name: 'camera' },
  both:  { icon: '\uD83C\uDFA4\uD83D\uDCF7', title: 'Microphone & Camera Access', name: 'microphone and camera' }
};

const info = labels[mediaType] || labels.audio;
icon.textContent = info.icon;
title.textContent = info.title;

async function requestAccess() {
  const types = mediaType === 'both' ? ['audio', 'video'] : [mediaType];

  for (const type of types) {
    const typeName = type === 'audio' ? 'Microphone' : 'Camera';
    status.textContent = `Requesting ${typeName.toLowerCase()} access...`;

    try {
      const constraints = type === 'audio' ? { audio: true } : { video: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach(t => t.stop());
      console.log(`[Talkover-permissions] ${typeName} access granted`);
    } catch (e) {
      console.error(`[Talkover-permissions] ${typeName} access failed:`, e.name, e.message);
      status.className = 'status error';

      if (e.name === 'NotAllowedError') {
        status.textContent = `${typeName} access was denied`;
        desc.textContent = 'You may have clicked "Block" or dismissed the prompt.';
        hint.innerHTML = 'To fix: click the camera/lock icon in the address bar, or go to<br><a href="chrome://settings/content/camera">chrome://settings</a> and allow this extension.';
      } else if (e.name === 'NotFoundError') {
        status.textContent = `No ${typeName.toLowerCase()} found`;
        desc.textContent = `Make sure a ${typeName.toLowerCase()} is connected to your computer.`;
      } else {
        status.textContent = `Error: ${e.message}`;
        desc.textContent = 'Something went wrong. Please try again.';
      }
      return;
    }
  }

  // All permissions granted
  status.className = 'status success';
  status.textContent = '\u2713 Access granted!';
  desc.textContent = 'You can now close this tab and click the Talkover icon to continue.';

  // Notify the extension
  try {
    chrome.runtime.sendMessage({ type: 'permissions-granted', mediaType });
  } catch (e) { /* popup might not be listening */ }

  // Auto-close after a moment
  setTimeout(() => {
    try { window.close(); } catch (e) {}
  }, 2000);
}

requestAccess();
