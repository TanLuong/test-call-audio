/**
 * Sharegram Call — WebRTC Client (WHIP/WHEP via SRS)
 *
 * Flow:
 *  1. Get camera/mic (getUserMedia)
 *  2. Join room via Socket.IO → receive myStreamName
 *  3. WHIP: publish local stream to SRS
 *  4. On 'peer-joined' event → WHEP: subscribe to peer's stream from SRS
 *  5. Render remote stream in <video id="remote-video">
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────
const SRS_API = ''; // Empty = same origin (proxied by nginx)
const ICE_GATHER_TIMEOUT_MS = 6000;
const WHEP_MAX_RETRIES = 20;
const WHEP_RETRY_DELAY_MS = 1500;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ─── State ────────────────────────────────────────────────────────────────────
let socket        = null;
let localStream   = null;
let publishPc     = null;
let subscribePc   = null;
let myStreamName  = null;
let roomCode      = null;
let isMicMuted    = false;
let isCameraOff   = false;
let isSpeakerMuted = false;
let callTimerInterval = null;
let callStartTime     = null;
let remoteStream      = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  roomCode = sessionStorage.getItem('roomCode');

  if (!roomCode) {
    window.location.href = 'index.html';
    return;
  }

  // Show room code in UI
  document.getElementById('topbar-room-code').textContent = roomCode;
  document.getElementById('room-badge').style.display = 'flex';
  document.getElementById('waiting-room-code-val').textContent = roomCode;
  document.getElementById('waiting-room-badge').style.display = 'flex';

  updateStatus('connecting', 'Đang khởi tạo...');
  setWaitingDesc('Đang truy cập camera và micro...');

  // 1. Get local media — fallback gracefully when camera/mic unavailable
  localStream = await getLocalMediaWithFallback();
  if (localStream && localStream.getVideoTracks().length > 0) {
    document.getElementById('local-video').srcObject = localStream;
  } else {
    // No camera — show placeholder in PIP
    showNoCameraPlaceholder();
    if (!localStream) {
      // No audio either — create silent stream so WHIP still works
      localStream = createSilentStream();
    }
  }

  // 2. Connect to signaling
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', async () => {
    console.log('[Socket] Connected:', socket.id);

    // Both creator and joiner call join-room here (new socket each page load)
    socket.emit('join-room', { roomCode }, async (res) => {
      if (!res.success) {
        showToast(res.error || 'Không thể vào phòng', 'error');
        setTimeout(() => window.location.href = 'index.html', 2000);
        return;
      }

      myStreamName = res.myStreamName;
      console.log('[Signaling] Joined room, my stream:', myStreamName);

      setWaitingDesc('Đang kết nối với SRS...');
      await startPublishing();

      updateStatus('connecting', 'Đang chờ người kia...');
      setWaitingDesc('Chia sẻ mã phòng <strong>' + roomCode + '</strong> hoặc chờ peer kết nối');
    });
  });

  // When peer joins, subscribe to their stream
  socket.on('peer-joined', async ({ peerStreamName }) => {
    console.log('[Signaling] Peer joined, stream:', peerStreamName);
    updateStatus('connecting', 'Đang kết nối với peer...');
    setWaitingDesc('Đang thiết lập kết nối video...');
    await startSubscribing(peerStreamName);
  });

  socket.on('peer-left', () => {
    console.log('[Signaling] Peer left');
    showToast('Người dùng kia đã rời phòng', 'info');
    updateStatus('disconnected', 'Peer đã ngắt kết nối');
    stopCallTimer();
    if (remoteStream) {
      remoteStream.getTracks().forEach(t => t.stop());
      document.getElementById('remote-video').srcObject = null;
    }
    document.getElementById('waiting-overlay').classList.remove('hidden');
    setWaitingDesc('Người dùng kia đã rời phòng');
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected');
    updateStatus('disconnected', 'Mất kết nối signaling');
  });

  // Drag PIP local video
  makeDraggable(document.getElementById('local-pip'));
})();

// ─── WHIP: Publish local stream to SRS ───────────────────────────────────────
async function startPublishing() {
  const tracks = localStream ? localStream.getTracks() : [];

  // If no tracks at all (viewer-only mode), skip publishing
  if (tracks.length === 0) {
    console.log('[WHIP] No local tracks — skipping publish (viewer-only mode)');
    if (socket) socket.emit('media-ready');
    return;
  }

  console.log('[WHIP] Publishing stream:', myStreamName);

  publishPc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });

  // Add local tracks (sendonly)
  localStream.getTracks().forEach(track => {
    publishPc.addTransceiver(track, { direction: 'sendonly' });
  });

  const offer = await publishPc.createOffer();
  await publishPc.setLocalDescription(offer);

  // Wait for ICE gathering
  await waitForIceGathering(publishPc);

  const url = `${SRS_API}/rtc/v1/whip/?app=live&stream=${myStreamName}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: publishPc.localDescription.sdp,
    });
  } catch (err) {
    console.error('[WHIP] Network error:', err);
    showToast('Không thể kết nối đến SRS server', 'error');
    updateStatus('disconnected', 'Lỗi kết nối SRS');
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error('[WHIP] Failed:', response.status, body);
    showToast(`WHIP thất bại (${response.status})`, 'error');
    return;
  }

  const answerSdp = await response.text();
  await publishPc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  console.log('[WHIP] Publishing started ✓');

  // Notify signaling that media is ready — include track info for peer to use
  const hasAudio = (localStream?.getAudioTracks().length ?? 0) > 0;
  const hasVideo = (localStream?.getVideoTracks().length ?? 0) > 0;
  if (socket) socket.emit('media-ready', { hasAudio, hasVideo });
  console.log('[WHIP] Media ready, hasAudio:', hasAudio, 'hasVideo:', hasVideo);
}

// ─── WHEP: Subscribe to peer's stream from SRS (with retry) ──────────────────
async function startSubscribing(peerStreamName) {
  console.log('[WHEP] Subscribing to stream:', peerStreamName);

  for (let attempt = 1; attempt <= WHEP_MAX_RETRIES; attempt++) {
    try {
      await doWhep(peerStreamName);
      console.log('[WHEP] Subscribed ✓');
      return;
    } catch (err) {
      console.warn(`[WHEP] Attempt ${attempt}/${WHEP_MAX_RETRIES} failed:`, err.message);
      if (attempt < WHEP_MAX_RETRIES) {
        await sleep(WHEP_RETRY_DELAY_MS);
      }
    }
  }

  showToast('Không thể nhận stream từ peer', 'error');
  updateStatus('disconnected', 'Lỗi nhận stream');
}

async function doWhep(peerStreamName) {
  // Clean up previous subscribe PC
  if (subscribePc) {
    subscribePc.close();
    subscribePc = null;
  }

  // Get peer's track info from signaling server (reliable, set by peer on publish)
  const tracks = await getPeerTracksFromSignaling(peerStreamName);
  console.log('[WHEP] Peer tracks:', tracks);

  subscribePc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });

  // Add only transceivers for tracks the peer actually published
  // Matching the exact set avoids m-line count mismatch with SRS answer
  if (tracks.hasAudio) subscribePc.addTransceiver('audio', { direction: 'recvonly' });
  if (tracks.hasVideo) subscribePc.addTransceiver('video', { direction: 'recvonly' });
  // Ultimate fallback: no info → add both
  if (!tracks.hasAudio && !tracks.hasVideo) {
    subscribePc.addTransceiver('audio', { direction: 'recvonly' });
    subscribePc.addTransceiver('video', { direction: 'recvonly' });
  }

  // Handle incoming tracks
  remoteStream = new MediaStream();
  const remoteVideo = document.getElementById('remote-video');
  let peerConnectedFired = false;

  subscribePc.ontrack = (event) => {
    console.log('[WHEP] Received track:', event.track.kind, 'muted:', event.track.muted);

    // Prefer event.streams[0] if available, otherwise build manually
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      remoteStream.addTrack(event.track);
      remoteVideo.srcObject = remoteStream;
    }

    // Ensure volume is up (not muted) and explicitly trigger playback
    remoteVideo.volume = 1;
    remoteVideo.muted  = false;
    remoteVideo.play().then(() => {
      console.log('[WHEP] Remote playback started ✓');
    }).catch(err => {
      console.warn('[WHEP] autoplay blocked:', err.message,
        '— waiting for user interaction');
      // Fallback: play on next user interaction
      const playOnce = () => {
        remoteVideo.play().catch(() => {});
        document.removeEventListener('click', playOnce);
      };
      document.addEventListener('click', playOnce);
    });

    // Signal connected only once
    if (!peerConnectedFired) {
      peerConnectedFired = true;
      onPeerConnected();
    }
  };

  subscribePc.onconnectionstatechange = () => {
    console.log('[WHEP] Connection state:', subscribePc.connectionState);
    if (subscribePc.connectionState === 'failed') {
      updateStatus('disconnected', 'Kết nối thất bại');
    }
  };

  const offer = await subscribePc.createOffer();
  await subscribePc.setLocalDescription(offer);
  await waitForIceGathering(subscribePc);

  const url = `${SRS_API}/rtc/v1/whep/?app=live&stream=${peerStreamName}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: subscribePc.localDescription.sdp,
  });

  if (response.status === 404) throw new Error('Stream not ready yet (404)');
  if (!response.ok) throw new Error(`WHEP error: ${response.status}`);

  const rawAnswer = await response.text();

  // Fix m-line order in SRS answer to match our offer (Chrome strict validation)
  const fixedAnswer = fixSdpMLineOrder(subscribePc.localDescription.sdp, rawAnswer);
  console.log('[WHEP] Setting remote description');
  await subscribePc.setRemoteDescription({ type: 'answer', sdp: fixedAnswer });
}

/**
 * Ask the signaling server for the peer's track info (hasAudio/hasVideo).
 * The peer emits this info via media-ready after successfully publishing to SRS.
 * Falls back to {hasAudio:true, hasVideo:true} if not available yet.
 */
async function getPeerTracksFromSignaling(peerStreamName) {
  if (!socket || !socket.connected) return { hasAudio: true, hasVideo: true };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ hasAudio: true, hasVideo: true }), 2000);
    socket.emit('get-peer-tracks', { streamName: peerStreamName }, (res) => {
      clearTimeout(timer);
      if (res && (res.hasAudio || res.hasVideo)) {
        resolve({ hasAudio: !!res.hasAudio, hasVideo: !!res.hasVideo });
      } else {
        // Peer info not ready yet or unknown — fallback to both
        resolve({ hasAudio: true, hasVideo: true });
      }
    });
  });
}

/**
 * Reorder SDP answer m-lines to match the offer m-line order.
 * Fixes "The order of m-lines in answer doesn't match order in offer" in Chrome.
 */
function fixSdpMLineOrder(offerSdp, answerSdp) {
  try {
    // Split SDP into session header + media sections
    const splitSections = (sdp) => {
      const parts = sdp.split(/^(?=m=)/m);
      return { header: parts[0], sections: parts.slice(1) };
    };

    const offer  = splitSections(offerSdp);
    const answer = splitSections(answerSdp);

    if (offer.sections.length !== answer.sections.length) {
      console.warn('[SDP] m-line count mismatch, returning answer as-is');
      return answerSdp;
    }

    // Build map: media-type → answer section (handles duplicates by index)
    const offerTypes  = offer.sections.map(s => s.match(/^m=(\S+)/)?.[1]);
    const answerByIdx = answer.sections; // same count, reorder by index

    // Build answer map keyed by offer index → find matching answer section
    // SRS may return answer sections in different order
    const answerMap = {};
    answer.sections.forEach(s => {
      const type = s.match(/^m=(\S+)/)?.[1];
      if (!answerMap[type]) answerMap[type] = [];
      answerMap[type].push(s);
    });

    const reordered = offerTypes.map(type => {
      const list = answerMap[type];
      return list && list.length ? list.shift() : answerByIdx.shift();
    });

    return answer.header + reordered.join('');
  } catch (e) {
    console.warn('[SDP] fixSdpMLineOrder failed:', e.message);
    return answerSdp;
  }
}


// ─── Connected state ──────────────────────────────────────────────────────────
function onPeerConnected() {
  document.getElementById('waiting-overlay').classList.add('hidden');
  document.getElementById('peer-name-label').textContent = 'Peer';
  document.getElementById('call-timer').style.display = 'block';
  updateStatus('connected', 'Đã kết nối');
  startCallTimer();
  showToast('Cuộc gọi đã bắt đầu!', 'success');
}

// ─── Controls ─────────────────────────────────────────────────────────────────
function toggleMic() {
  if (!localStream) return;
  isMicMuted = !isMicMuted;
  localStream.getAudioTracks().forEach(t => (t.enabled = !isMicMuted));

  const btn = document.getElementById('btn-mic');
  btn.classList.toggle('muted', isMicMuted);
  document.getElementById('icon-mic-on').style.display  = isMicMuted ? 'none' : 'block';
  document.getElementById('icon-mic-off').style.display = isMicMuted ? 'block' : 'none';
  document.getElementById('mic-label').textContent = isMicMuted ? 'Bật mic' : 'Micro';
  showToast(isMicMuted ? 'Đã tắt micro' : 'Đã bật micro', 'info');
}

function toggleCamera() {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach(t => (t.enabled = !isCameraOff));

  const btn = document.getElementById('btn-camera');
  btn.classList.toggle('off', isCameraOff);
  document.getElementById('icon-cam-on').style.display  = isCameraOff ? 'none' : 'block';
  document.getElementById('icon-cam-off').style.display = isCameraOff ? 'block' : 'none';
  document.getElementById('cam-label').textContent = isCameraOff ? 'Bật cam' : 'Camera';
  document.getElementById('local-video-off').style.display = isCameraOff ? 'flex' : 'none';
  showToast(isCameraOff ? 'Đã tắt camera' : 'Đã bật camera', 'info');
}

function toggleSpeaker() {
  isSpeakerMuted = !isSpeakerMuted;
  const remoteVideo = document.getElementById('remote-video');
  remoteVideo.muted = isSpeakerMuted;

  const btn = document.getElementById('btn-speaker');
  btn.classList.toggle('muted', isSpeakerMuted);
  document.getElementById('icon-spk-on').style.display  = isSpeakerMuted ? 'none' : 'block';
  document.getElementById('icon-spk-off').style.display = isSpeakerMuted ? 'block' : 'none';
  document.getElementById('spk-label').textContent = isSpeakerMuted ? 'Bật loa' : 'Loa';
  showToast(isSpeakerMuted ? 'Đã tắt loa' : 'Đã bật loa', 'info');
}

function endCall() {
  if (!confirm('Bạn có chắc muốn kết thúc cuộc gọi?')) return;
  cleanup();
  sessionStorage.clear();
  window.location.href = 'index.html';
}

function cleanup() {
  stopCallTimer();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (publishPc)   publishPc.close();
  if (subscribePc) subscribePc.close();
  if (socket)      socket.disconnect();
}

// ─── Call Timer ───────────────────────────────────────────────────────────────
function startCallTimer() {
  callStartTime = Date.now();
  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    document.getElementById('call-timer').textContent = `${m}:${s}`;
  }, 1000);
}
function stopCallTimer() {
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function updateStatus(state, text) {
  const badge = document.getElementById('status-badge');
  badge.className = `status-badge ${state}`;
  document.getElementById('status-text').textContent = text;
}

function setWaitingDesc(html) {
  document.getElementById('waiting-desc').innerHTML = html;
}

// ─── ICE Gathering Helper ─────────────────────────────────────────────────────
function waitForIceGathering(pc) {
  return Promise.race([
    new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') resolve();
      };
    }),
    sleep(ICE_GATHER_TIMEOUT_MS), // timeout fallback
  ]);
}

// ─── Drag PIP ─────────────────────────────────────────────────────────────────
function makeDraggable(el) {
  let startX, startY, startLeft, startTop;
  el.addEventListener('pointerdown', (e) => {
    startX    = e.clientX;
    startY    = e.clientY;
    const rect = el.getBoundingClientRect();
    startLeft  = rect.left;
    startTop   = rect.top;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, startLeft + dx));
    const newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, startTop + dy));
    el.style.left   = newLeft + 'px';
    el.style.top    = newTop  + 'px';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
  });
  el.addEventListener('pointerup', () => { el.style.cursor = 'grab'; });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  clearTimeout(toastTimer);
  t.textContent = msg;
  t.className   = `toast ${type} show`;
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3000);
}

// ─── Media Helpers ────────────────────────────────────────────────────────────

/**
 * Try to get media with graceful fallback:
 *  1. video + audio
 *  2. audio only (no camera)
 *  3. null (no devices at all — will use silent stream)
 */
async function getLocalMediaWithFallback() {
  // Try video + audio
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    showToast('Camera và micro đã sẵn sàng', 'success');
    return stream;
  } catch (e) {
    console.warn('[Media] video+audio failed:', e.name, e.message);
  }

  // Try audio only
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    showToast('Không có camera — chỉ dùng micro', 'info');
    return stream;
  } catch (e) {
    console.warn('[Media] audio-only failed:', e.name, e.message);
  }

  // No devices
  showToast('Không tìm thấy camera/micro — chỉ xem', 'info');
  updateStatus('connecting', 'Chế độ xem (không có thiết bị)');
  return null;
}

/** Show a "no camera" placeholder in the local PIP box */
function showNoCameraPlaceholder() {
  document.getElementById('local-video').style.display = 'none';
  document.getElementById('local-video-off').style.display = 'flex';
  // Change the camera button to disabled state
  const camBtn = document.getElementById('btn-camera');
  if (camBtn) {
    camBtn.disabled = true;
    camBtn.title = 'Không có camera';
    camBtn.style.opacity = '0.4';
  }
}

/** Create a silent MediaStream (black video + silent audio) as fallback */
function createSilentStream() {
  try {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    // Oscillator at 0 volume = silent
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    return dest.stream;
  } catch (e) {
    console.warn('[Media] createSilentStream failed:', e);
    return new MediaStream(); // empty stream
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);
