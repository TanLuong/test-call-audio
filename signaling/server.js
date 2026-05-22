const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// rooms: Map<roomCode, Array<{ socketId, streamName, ready }>>
const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function cleanRoomCode(code) {
  return String(code || '').trim().toUpperCase();
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let myStreamName = null;

  console.log(`[+] Connected: ${socket.id}`);

  // Create a new room
  socket.on('create-room', (callback) => {
    let code;
    let attempts = 0;
    do {
      code = generateRoomCode();
      attempts++;
    } while (rooms.has(code) && attempts < 100);

    rooms.set(code, []);
    currentRoom = code;
    socket.join(code);
    console.log(`[Room] Created: ${code} by ${socket.id}`);
    callback({ success: true, roomCode: code });
  });

  // Join an existing room
  socket.on('join-room', ({ roomCode }, callback) => {
    const code = cleanRoomCode(roomCode);
    const room = rooms.get(code);

    if (!room) {
      return callback({ success: false, error: 'Phòng không tồn tại' });
    }
    if (room.length >= 2) {
      return callback({ success: false, error: 'Phòng đã đầy (tối đa 2 người)' });
    }
    // Check if already in room
    if (room.find(p => p.socketId === socket.id)) {
      return callback({ success: false, error: 'Bạn đã ở trong phòng này' });
    }

    currentRoom = code;
    myStreamName = `${code}-${socket.id.substring(0, 8)}`;
    room.push({ socketId: socket.id, streamName: myStreamName, ready: false });
    socket.join(code);

    console.log(`[Room] ${socket.id} joined ${code} as stream: ${myStreamName}`);
    callback({ success: true, myStreamName, roomCode: code });

    // Notify existing members that someone joined
    socket.to(code).emit('peer-joined', { peerStreamName: myStreamName });

    // If room has 2 people, also let the newcomer know peer's stream
    if (room.length === 2) {
      const peerInfo = room.find(p => p.socketId !== socket.id);
      if (peerInfo) {
        socket.emit('peer-joined', { peerStreamName: peerInfo.streamName });
      }
    }
  });

  // Signal: peer media is ready (publishing to SRS)
  socket.on('media-ready', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const me = room.find(p => p.socketId === socket.id);
    if (me) me.ready = true;
    console.log(`[Media] ${socket.id} media ready in room ${currentRoom}`);
  });

  // Relay ICE candidates (if needed for future TURN support)
  socket.on('ice-candidate', ({ candidate }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('ice-candidate', { candidate });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        const idx = room.findIndex(p => p.socketId === socket.id);
        if (idx !== -1) room.splice(idx, 1);
        // Notify remaining peer
        socket.to(currentRoom).emit('peer-left');
        // Clean up empty rooms
        if (room.length === 0) {
          rooms.delete(currentRoom);
          console.log(`[Room] Deleted empty room: ${currentRoom}`);
        }
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size }));

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
