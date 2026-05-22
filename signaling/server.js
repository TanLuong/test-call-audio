const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// rooms: Map<roomCode, { members: Array<{socketId, streamName}>, createdAt: number }>
const rooms = new Map();

// Clean up rooms older than 2 hours with 0 members
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (room.members.length === 0 && now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(code);
      console.log(`[Room] TTL expired, deleted: ${code}`);
    }
  }
}, 60 * 1000);

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function cleanRoomCode(code) {
  return String(code || '').trim().toUpperCase();
}

io.on('connection', (socket) => {
  let currentRoom  = null;
  let myStreamName = null;
  let hasJoined    = false; // true only after join-room, NOT create-room

  console.log(`[+] Connected: ${socket.id}`);

  // ── Create room ──────────────────────────────────────────────────────────────
  // Called from index.html — only creates room, does NOT add creator to members.
  // Creator joins via call.html (new socket).
  socket.on('create-room', (callback) => {
    let code, attempts = 0;
    do { code = generateRoomCode(); attempts++; }
    while (rooms.has(code) && attempts < 100);

    rooms.set(code, { members: [], createdAt: Date.now() });
    currentRoom = code; // track so we can log on disconnect
    // hasJoined stays false — creator socket disconnect won't delete the room
    console.log(`[Room] Created: ${code} by ${socket.id}`);
    callback({ success: true, roomCode: code });
  });

  // ── Check room (validate only, does NOT join) ─────────────────────────────
  // Called from index.html by the joiner to verify room exists before navigating.
  socket.on('check-room', ({ roomCode }, callback) => {
    const code = cleanRoomCode(roomCode);
    const room = rooms.get(code);
    if (!room)                    return callback({ success: false, error: 'Phòng không tồn tại' });
    if (room.members.length >= 2) return callback({ success: false, error: 'Phòng đã đầy (tối đa 2 người)' });
    callback({ success: true });
  });

  // ── Join room ─────────────────────────────────────────────────────────────
  // Called from call.html — both creator and joiner join here (each on new socket).
  socket.on('join-room', ({ roomCode }, callback) => {
    const code = cleanRoomCode(roomCode);
    const room = rooms.get(code);

    if (!room)                    return callback({ success: false, error: 'Phòng không tồn tại' });
    if (room.members.length >= 2) return callback({ success: false, error: 'Phòng đã đầy (tối đa 2 người)' });

    // Guard: already joined
    const existing = room.members.find(p => p.socketId === socket.id);
    if (existing) return callback({ success: true, myStreamName: existing.streamName, roomCode: code });

    currentRoom  = code;
    hasJoined    = true;
    myStreamName = `${code}-${socket.id.substring(0, 8)}`;
    room.members.push({ socketId: socket.id, streamName: myStreamName });
    socket.join(code);

    console.log(`[Room] ${socket.id} joined ${code} as "${myStreamName}" (${room.members.length}/2)`);
    callback({ success: true, myStreamName, roomCode: code });

    // Tell peer(s) already in room that someone joined
    socket.to(code).emit('peer-joined', { peerStreamName: myStreamName });

    // If this is the 2nd person, also tell newcomer about the existing peer
    if (room.members.length === 2) {
      const peer = room.members.find(p => p.socketId !== socket.id);
      if (peer) socket.emit('peer-joined', { peerStreamName: peer.streamName });
    }
  });

  // ── Media ready ────────────────────────────────────────────────────────────
  socket.on('media-ready', ({ hasAudio = false, hasVideo = false } = {}) => {
    if (!currentRoom || !hasJoined) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const me = room.members.find(p => p.socketId === socket.id);
    if (me) {
      me.ready    = true;
      me.hasAudio = hasAudio;
      me.hasVideo = hasVideo;
      console.log(`[Media] ${socket.id} ready in ${currentRoom} audio=${hasAudio} video=${hasVideo}`);
    }
  });

  // ── Get peer track info ───────────────────────────────────────────────────
  socket.on('get-peer-tracks', ({ streamName }, callback) => {
    // Find the room this socket is in, then find the member with the given streamName
    let found = null;
    for (const [, room] of rooms.entries()) {
      const member = room.members.find(m => m.streamName === streamName);
      if (member) { found = member; break; }
    }
    if (found && found.ready) {
      callback({ hasAudio: !!found.hasAudio, hasVideo: !!found.hasVideo });
    } else {
      callback({}); // not ready yet — caller will use fallback
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id} (hasJoined=${hasJoined}, room=${currentRoom})`);

    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (hasJoined) {
      // Actual member left — remove and notify peer
      const idx = room.members.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) room.members.splice(idx, 1);
      socket.to(currentRoom).emit('peer-left');

      if (room.members.length === 0) {
        rooms.delete(currentRoom);
        console.log(`[Room] Empty after member left, deleted: ${currentRoom}`);
      }
    } else {
      // Creator's index.html socket disconnected — KEEP the room alive
      // The creator will join properly from call.html with a new socket
      console.log(`[Room] Creator index.html socket gone, room "${currentRoom}" stays alive`);
    }
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
