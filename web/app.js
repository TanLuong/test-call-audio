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
  const role        = sessionStorage.getItem('role');
  const savedStream = sessionStorage.getItem('myStreamName');

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

  // 1. Get local media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('local-video').srcObject = localStream;
  } catch (err) {
    console.error('[Media] getUserMedia failed:', err);
    showToast('Không thể truy cập camera/micro: ' + err.message, 'error');
    updateStatus('disconnected', 'Lỗi thiết bị');
    return;
  }

  // 2. Connect to signaling
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', async () => {
    console.log('[Socket] Connected:', socket.id);

    // If joiner already joined via index.html, skip re-joining
    if (role === 'joiner' && savedStream) {
      myStreamName = savedStream;
      sessionStorage.removeItem('myStreamName');
      setWaitingDesc('Đang kết nối với SRS...');
      await startPublishing();
      updateStatus('connecting', 'Chờ người kia vào phòng...');
      setWaitingDesc('Chia sẻ mã phòng <strong>' + roomCode + '</strong> cho người kia');
    } else {
      // Creator: join room fresh
      socket.emit('join-room', { roomCode }, async (res) => {
        if (!res.success) {
          showToast(res.error || 'Không thể vào phòng', 'error');
          setTimeout(() => window.location.href = 'index.html', 2000);
          return;
        }
        myStreamName = res.myStreamName;
        setWaitingDesc('Đang kết nối với SRS...');
        await startPublishing();
        updateStatus('connecting', 'Chờ người kia vào phòng...');
        setWaitingDesc('Chia sẻ mã phòng <strong>' + roomCode + '</strong> cho người kia');
      });
    }
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

  // Notify signaling that media is ready
  if (socket) socket.emit('media-ready');
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

  subscribePc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });

  // Add receive-only transceivers
  subscribePc.addTransceiver('audio', { direction: 'recvonly' });
  subscribePc.addTransceiver('video', { direction: 'recvonly' });

  // Handle incoming tracks
  remoteStream = new MediaStream();
  const remoteVideo = document.getElementById('remote-video');

  subscribePc.ontrack = (event) => {
    console.log('[WHEP] Received track:', event.track.kind);
    remoteStream.addTrack(event.track);
    remoteVideo.srcObject = remoteStream;

    // When we get the first track, start connected state
    if (remoteStream.getTracks().length >= 1) {
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

  const answerSdp = await response.text();
  await subscribePc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
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

// ─── Utility ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);
