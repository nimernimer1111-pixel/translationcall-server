const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ============================================
// Admin Config
// ============================================
const ADMIN_PASSWORD = crypto
  .createHash('sha256')
  .update('Oadmin@111')
  .digest('hex');

const ADMIN_PATH = 'admin-ojs111';
let adminSocket = null;

// ============================================
// Database
// ============================================
const rooms = new Map();
const blockedUsers = new Set();
const activityLog = [];
const stats = {
  totalRooms: 0,
  totalMessages: 0,
  totalUsers: 0,
  languages: {}
};
let maintenanceMode = false;

// ============================================
// Helpers
// ============================================
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateCode() : code;
}

function addLog(type, message, data = {}) {
  const entry = {
    id: uuidv4(),
    type,
    message,
    data,
    timestamp: new Date()
  };
  activityLog.unshift(entry);
  if (activityLog.length > 100) activityLog.pop();

  // Send to admin if connected
  if (adminSocket) {
    adminSocket.emit('new-log', entry);
  }
  return entry;
}

function notifyAdmin(event, data) {
  if (adminSocket) {
    adminSocket.emit(event, data);
  }
}

function getRoomsData() {
  return Array.from(rooms.values()).map(room => ({
    id: room.id,
    isPrivate: room.isPrivate,
    status: room.status,
    participants: Array.from(room.participants.values()).map(p => ({
      id: p.id,
      name: p.name,
      language: p.language,
      joinedAt: p.joinedAt
    })),
    createdAt: room.createdAt,
    messageCount: room.messages.length
  }));
}

// ============================================
// Socket Events
// ============================================
io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  // Check if blocked
  if (blockedUsers.has(socket.id)) {
    socket.emit('blocked', { message: 'تم حظرك من الموقع' });
    socket.disconnect();
    return;
  }

  // Check maintenance mode
  if (maintenanceMode) {
    socket.emit('maintenance', { message: 'الموقع في وضع الصيانة' });
    socket.disconnect();
    return;
  }

  // ==================
  // Admin Login
  // ==================
  socket.on('admin-login', (data, callback) => {
    const hashedPass = crypto
      .createHash('sha256')
      .update(data.password)
      .digest('hex');

    if (hashedPass === ADMIN_PASSWORD) {
      adminSocket = socket;
      socket.isAdmin = true;

      callback({
        success: true,
        stats: {
          ...stats,
          activeRooms: rooms.size,
          blockedUsers: blockedUsers.size
        },
        rooms: getRoomsData(),
        logs: activityLog,
        maintenanceMode,
        blockedList: Array.from(blockedUsers)
      });

      addLog('admin', '✅ المسؤول دخل للوحة التحكم');
      console.log('🔐 Admin connected');
    } else {
      callback({ success: false, error: 'كلمة المرور غير صحيحة' });
      addLog('warning', '⚠️ محاولة دخول فاشلة للوحة التحكم', {
        ip: socket.handshake.address
      });
    }
  });

  // ==================
  // Admin Actions
  // ==================
  socket.on('admin-block-user', (data, callback) => {
    if (!socket.isAdmin) return;
    blockedUsers.add(data.userId);

    // Disconnect the user
    const userSocket = io.sockets.sockets.get(data.userId);
    if (userSocket) {
      userSocket.emit('blocked', { message: 'تم حظرك من الموقع من قبل المسؤول' });
      userSocket.disconnect();
    }

    addLog('admin', `🚫 تم حظر المستخدم: ${data.userName || data.userId}`);
    callback({ success: true });
    notifyAdmin('stats-update', {
      activeRooms: rooms.size,
      blockedUsers: blockedUsers.size,
      ...stats
    });
  });

  socket.on('admin-unblock-user', (data, callback) => {
    if (!socket.isAdmin) return;
    blockedUsers.delete(data.userId);
    addLog('admin', `✅ تم رفع الحظر عن: ${data.userId}`);
    callback({ success: true });
  });

  socket.on('admin-delete-room', (data, callback) => {
    if (!socket.isAdmin) return;
    const room = rooms.get(data.roomId);
    if (room) {
      // Notify participants
      io.to(data.roomId).emit('room-deleted', {
        message: 'تم حذف الغرفة من قبل المسؤول'
      });
      rooms.delete(data.roomId);
      addLog('admin', `🗑️ تم حذف الغرفة: ${data.roomId}`);
      callback({ success: true });
      notifyAdmin('rooms-update', getRoomsData());
    } else {
      callback({ success: false, error: 'الغرفة غير موجودة' });
    }
  });

  socket.on('admin-send-warning', (data, callback) => {
    if (!socket.isAdmin) return;
    const userSocket = io.sockets.sockets.get(data.userId);
    if (userSocket) {
      userSocket.emit('admin-warning', { message: data.message });
      addLog('admin', `⚠️ تم إرسال تحذير لـ: ${data.userName || data.userId}`);
      callback({ success: true });
    } else {
      callback({ success: false, error: 'المستخدم غير متصل' });
    }
  });

  socket.on('admin-toggle-maintenance', (data, callback) => {
    if (!socket.isAdmin) return;
    maintenanceMode = data.enabled;
    addLog('admin', `🔧 وضع الصيانة: ${maintenanceMode ? 'مفعل' : 'معطل'}`);
    callback({ success: true, maintenanceMode });

    if (maintenanceMode) {
      // Disconnect all non-admin users
      io.sockets.sockets.forEach((s) => {
        if (!s.isAdmin) {
          s.emit('maintenance', { message: 'الموقع في وضع الصيانة مؤقتاً' });
          s.disconnect();
        }
      });
    }
  });

  socket.on('admin-get-stats', (callback) => {
    if (!socket.isAdmin) return;
    callback({
      ...stats,
      activeRooms: rooms.size,
      activeUsers: io.sockets.sockets.size,
      blockedUsers: blockedUsers.size,
      maintenanceMode
    });
  });

  // ==================
  // Create Room
  // ==================
  socket.on('create-room', (options, callback) => {
    if (maintenanceMode) {
      callback({ success: false, error: 'الموقع في وضع الصيانة' });
      return;
    }

    const roomId = generateCode();
    const room = {
      id: roomId,
      hostId: socket.id,
      isPrivate: options.isPrivate || false,
      password: options.password || null,
      participants: new Map(),
      messages: [],
      createdAt: new Date(),
      status: 'waiting'
    };

    room.participants.set(socket.id, {
      id: socket.id,
      name: options.userName || 'مضيف',
      language: options.language || 'ar',
      isHost: true,
      joinedAt: new Date()
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    stats.totalRooms++;
    stats.totalUsers++;

    if (options.language) {
      stats.languages[options.language] = (stats.languages[options.language] || 0) + 1;
    }

    addLog('room', `🏠 غرفة جديدة: ${roomId} - المضيف: ${options.userName}`);

    // Notify admin
    notifyAdmin('new-room', {
      roomId,
      hostName: options.userName,
      language: options.language,
      isPrivate: options.isPrivate,
      timestamp: new Date()
    });
    notifyAdmin('rooms-update', getRoomsData());
    notifyAdmin('stats-update', {
      ...stats,
      activeRooms: rooms.size,
      activeUsers: io.sockets.sockets.size
    });

    callback({ success: true, roomId });
  });

  // ==================
  // Join Room
  // ==================
  socket.on('join-room', (data, callback) => {
    if (maintenanceMode) {
      callback({ success: false, error: 'الموقع في وضع الصيانة' });
      return;
    }

    const { roomId, userName, language, password } = data;
    const room = rooms.get(roomId);

    if (!room) return callback({ success: false, error: 'الغرفة غير موجودة' });
    if (room.participants.size >= 2 && !room.participants.has(socket.id)) {
      return callback({ success: false, error: 'الغرفة ممتلئة' });
    }
    if (room.isPrivate && room.password !== password && !room.participants.has(socket.id)) {
      return callback({ success: false, error: 'كلمة المرور غير صحيحة' });
    }

    if (!room.participants.has(socket.id)) {
      room.participants.set(socket.id, {
        id: socket.id,
        name: userName,
        language,
        isHost: false,
        joinedAt: new Date()
      });
    }

    room.status = 'active';
    socket.join(roomId);
    stats.totalUsers++;

    if (language) {
      stats.languages[language] = (stats.languages[language] || 0) + 1;
    }

    const host = room.participants.get(room.hostId);

    socket.to(roomId).emit('partner-joined', {
      id: socket.id,
      name: userName,
      language
    });

    addLog('room', `👥 ${userName} انضم للغرفة: ${roomId}`);

    notifyAdmin('user-joined-room', {
      roomId,
      userName,
      language,
      timestamp: new Date()
    });
    notifyAdmin('rooms-update', getRoomsData());
    notifyAdmin('stats-update', {
      ...stats,
      activeRooms: rooms.size,
      activeUsers: io.sockets.sockets.size
    });

    callback({
      success: true,
      roomId,
      partner: host && host.id !== socket.id ? {
        id: host.id,
        name: host.name,
        language: host.language
      } : null,
      messages: room.messages
    });
  });

  // ==================
  // Voice Message
  // ==================
  socket.on('voice-message', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const message = {
      id: uuidv4(),
      senderId: socket.id,
      senderName: data.senderName,
      senderLanguage: data.senderLanguage,
      targetLanguage: data.targetLanguage,
      originalText: data.originalText,
      translatedText: data.translatedText,
      timestamp: new Date(),
      type: 'voice'
    };

    room.messages.push(message);
    stats.totalMessages++;

    io.to(data.roomId).emit('new-message', message);
    notifyAdmin('stats-update', {
      ...stats,
      activeRooms: rooms.size
    });
  });

  // ==================
  // Speaking
  // ==================
  socket.on('speaking', (data) => {
    socket.to(data.roomId).emit('partner-speaking', {
      speaking: data.speaking
    });
  });

  // ==================
  // Leave Room
  // ==================
  socket.on('leave-room', (data) => {
    handleLeave(socket, data.roomId);
  });

  // ==================
  // Disconnect
  // ==================
  socket.on('disconnect', () => {
    if (socket.isAdmin) {
      adminSocket = null;
      console.log('🔐 Admin disconnected');
    }
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
    addLog('room', `🗑️ انتهت الغرفة: ${roomId}`);
  } else {
    socket.to(roomId).emit('partner-left', {
      name: participant?.name || 'الشريك'
    });
    room.status = 'waiting';
    addLog('room', `👋 ${participant?.name} غادر الغرفة: ${roomId}`);
  }

  notifyAdmin('rooms-update', getRoomsData());
  notifyAdmin('stats-update', {
    ...stats,
    activeRooms: rooms.size,
    activeUsers: io.sockets.sockets.size
  });
}

// ============================================
// API Routes
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: '✅ TranslationCall Pro Server',
    rooms: rooms.size,
    maintenance: maintenanceMode
  });
});

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

app.get('/stats', (req, res) => {
  res.json({
    ...stats,
    activeRooms: rooms.size,
    activeUsers: io.sockets.sockets.size
  });
});

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🎙️  TranslationCall Pro Server         ║
║   🚀 Port: ${PORT}                         ║
║   🔐 Admin: /${ADMIN_PATH}        ║
╚══════════════════════════════════════════╝
  `);
});
