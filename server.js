// ============================================
// TranslationCall Pro - Server
// ============================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ============================================
// Database (Memory)
// ============================================
const rooms = new Map();
const stats = {
  totalRooms: 0,
  totalMessages: 0,
  totalMinutes: 0
};

// ============================================
// Room Manager
// ============================================
function createRoom(hostId, options = {}) {
  const roomId = generateCode();
  const room = {
    id: roomId,
    hostId,
    isPrivate: options.isPrivate || false,
    password: options.password || null,
    participants: new Map(),
    messages: [],
    createdAt: new Date(),
    status: 'waiting'
  };
  rooms.set(roomId, room);
  stats.totalRooms++;
  return room;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateCode() : code;
}

// ============================================
// Socket Events
// ============================================
io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  // ==================
  // Create Room
  // ==================
  socket.on('create-room', (options, callback) => {
    try {
      const room = createRoom(socket.id, options);
      
      // Add host as participant
      room.participants.set(socket.id, {
        id: socket.id,
        name: options.userName || 'Host',
        language: options.language || 'ar',
        isHost: true,
        joinedAt: new Date()
      });

      socket.join(room.id);

      callback({
        success: true,
        roomId: room.id,
        isPrivate: room.isPrivate
      });

      console.log(`🏠 Room created: ${room.id}`);
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // ==================
  // Join Room
  // ==================
  socket.on('join-room', (data, callback) => {
    const { roomId, userName, language, password } = data;
    const room = rooms.get(roomId);

    if (!room) {
      return callback({ success: false, error: 'الغرفة غير موجودة' });
    }

    if (room.participants.size >= 2) {
      return callback({ success: false, error: 'الغرفة ممتلئة' });
    }

    if (room.isPrivate && room.password !== password) {
      return callback({ success: false, error: 'كلمة المرور غير صحيحة' });
    }

    // Add participant
    room.participants.set(socket.id, {
      id: socket.id,
      name: userName,
      language,
      isHost: false,
      joinedAt: new Date()
    });

    room.status = 'active';
    socket.join(roomId);

    // Get partner info
    const hostId = room.hostId;
    const host = room.participants.get(hostId);

    // Notify host
    socket.to(roomId).emit('partner-joined', {
      id: socket.id,
      name: userName,
      language
    });

    callback({
      success: true,
      roomId,
      partner: host ? {
        id: host.id,
        name: host.name,
        language: host.language
      } : null,
      messages: room.messages
    });

    console.log(`👥 ${userName} joined room: ${roomId}`);
  });

  // ==================
  // Voice Message
  // ==================
  socket.on('voice-message', async (data) => {
    const { roomId, originalText, translatedText, 
            senderName, senderLanguage, targetLanguage } = data;
    
    const room = rooms.get(roomId);
    if (!room) return;

    const message = {
      id: uuidv4(),
      senderId: socket.id,
      senderName,
      senderLanguage,
      targetLanguage,
      originalText,
      translatedText,
      timestamp: new Date(),
      type: 'voice'
    };

    room.messages.push(message);
    stats.totalMessages++;

    // Send to everyone in room
    io.to(roomId).emit('new-message', {
      ...message,
      isOwn: false
    });
  });

  // ==================
  // Text Message
  // ==================
  socket.on('text-message', async (data) => {
    const { roomId, originalText, translatedText,
            senderName, senderLanguage, targetLanguage } = data;
    
    const room = rooms.get(roomId);
    if (!room) return;

    const message = {
      id: uuidv4(),
      senderId: socket.id,
      senderName,
      senderLanguage,
      targetLanguage,
      originalText,
      translatedText,
      timestamp: new Date(),
      type: 'text'
    };

    room.messages.push(message);
    stats.totalMessages++;

    io.to(roomId).emit('new-message', message);
  });

  // ==================
  // Speaking Indicator
  // ==================
  socket.on('speaking', (data) => {
    socket.to(data.roomId).emit('partner-speaking', {
      speaking: data.speaking
    });
  });

  // ==================
  // WebRTC Signaling
  // ==================
  socket.on('rtc-offer', (data) => {
    socket.to(data.roomId).emit('rtc-offer', {
      offer: data.offer,
      from: socket.id
    });
  });

  socket.on('rtc-answer', (data) => {
    socket.to(data.roomId).emit('rtc-answer', {
      answer: data.answer,
      from: socket.id
    });
  });

  socket.on('rtc-ice', (data) => {
    socket.to(data.roomId).emit('rtc-ice', {
      candidate: data.candidate,
      from: socket.id
    });
  });

  // ==================
  // Leave Room
  // ==================
  socket.on('leave-room', (data) => {
    handleLeave(socket, data.roomId);
  });

  // ==================
  // Get Stats
  // ==================
  socket.on('get-stats', (callback) => {
    callback({
      activeRooms: rooms.size,
      ...stats
    });
  });

  // ==================
  // Disconnect
  // ==================
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);
    
    // Find and leave any room
    rooms.forEach((room, roomId) => {
      if (room.participants.has(socket.id)) {
        handleLeave(socket, roomId);
      }
    });
  });
});

// ============================================
// Handle Leave
// ============================================
function handleLeave(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const participant = room.participants.get(socket.id);
  room.participants.delete(socket.id);
  socket.leave(roomId);

  if (room.participants.size === 0) {
    rooms.delete(roomId);
    console.log(`🗑️ Room deleted: ${roomId}`);
  } else {
    // Notify remaining participant
    socket.to(roomId).emit('partner-left', {
      name: participant?.name || 'الشريك'
    });
    room.status = 'waiting';
  }
}

// ============================================
// API Routes
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ TranslationCall Pro Server Running',
    rooms: rooms.size,
    stats
  });
});

// Check room
app.get('/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (room) {
    res.json({
      exists: true,
      isPrivate: room.isPrivate,
      isFull: room.participants.size >= 2,
      participants: room.participants.size,
      status: room.status
    });
  } else {
    res.json({ exists: false });
  }
});

// Stats
app.get('/stats', (req, res) => {
  res.json({
    activeRooms: rooms.size,
    ...stats
  });
});

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   🎙️  TranslationCall Pro Server     ║
║   🚀 Running on port: ${PORT}          ║
║   ✅ Ready for connections            ║
╚══════════════════════════════════════╝
  `);
});
