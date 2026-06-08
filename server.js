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
// Config
// ============================================
const ADMIN_PASSWORD = crypto
  .createHash('sha256')
  .update('Oadmin@111')
  .digest('hex');
const ADMIN_PATH = 'admin-ojs111';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

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
  if (adminSocket) adminSocket.emit('new-log', entry);
  return entry;
}

function notifyAdmin(event, data) {
  if (adminSocket) adminSocket.emit(event, data);
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
// Gemini AI
// ============================================
async function callGemini(messages, systemPrompt) {
  try {
    const contents = [];

    // Add system prompt as first user message
    if (systemPrompt) {
      contents.push({
        role: 'user',
        parts: [{ text: systemPrompt }]
      });
      contents.push({
        role: 'model',
        parts: [{ text: 'Understood! I will follow these instructions.' }]
      });
    }

    // Add conversation history
    messages.forEach(msg => {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      });
    });

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 1024,
        },
        safetySettings: [
          {
            category: 'HARM_CATEGORY_HARASSMENT',
            threshold: 'BLOCK_MEDIUM_AND_ABOVE'
          }
        ]
      })
    });

    const data = await response.json();

    if (data.candidates && data.candidates[0]) {
      return data.candidates[0].content.parts[0].text;
    }

    return null;
  } catch (error) {
    console.error('Gemini error:', error);
    return null;
  }
}

// AI Contexts storage
const aiContexts = new Map();

// ============================================
// Socket Events
// ============================================
io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  if (blockedUsers.has(socket.id)) {
    socket.emit('blocked', { message: 'تم حظرك من الموقع' });
    socket.disconnect();
    return;
  }

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
        stats: { ...stats, activeRooms: rooms.size, blockedUsers: blockedUsers.size },
        rooms: getRoomsData(),
        logs: activityLog,
        maintenanceMode,
        blockedList: Array.from(blockedUsers)
      });
      addLog('admin', '✅ المسؤول دخل للوحة التحكم');
    } else {
      callback({ success: false, error: 'كلمة المرور غير صحيحة' });
      addLog('warning', '⚠️ محاولة دخول فاشلة للوحة التحكم');
    }
  });

  // ==================
  // Admin Actions
  // ==================
  socket.on('admin-block-user', (data, callback) => {
    if (!socket.isAdmin) return;
    blockedUsers.add(data.userId);
    const userSocket = io.sockets.sockets.get(data.userId);
    if (userSocket) {
      userSocket.emit('blocked', { message: 'تم حظرك من الموقع' });
      userSocket.disconnect();
    }
    addLog('admin', `🚫 تم حظر: ${data.userName || data.userId}`);
    callback({ success: true });
    notifyAdmin('stats-update', { activeRooms: rooms.size, blockedUsers: blockedUsers.size, ...stats });
  });

  socket.on('admin-unblock-user', (data, callback) => {
    if (!socket.isAdmin) return;
    blockedUsers.delete(data.userId);
    addLog('admin', `✅ رفع الحظر عن: ${data.userId}`);
    callback({ success: true });
  });

  socket.on('admin-delete-room', (data, callback) => {
    if (!socket.isAdmin) return;
    const room = rooms.get(data.roomId);
    if (room) {
      io.to(data.roomId).emit('room-deleted', { message: 'تم حذف الغرفة من قبل المسؤول' });
      rooms.delete(data.roomId);
      addLog('admin', `🗑️ حذف الغرفة: ${data.roomId}`);
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
      addLog('admin', `⚠️ تحذير لـ: ${data.userName}`);
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
      io.sockets.sockets.forEach((s) => {
        if (!s.isAdmin) {
          s.emit('maintenance', { message: 'الموقع في وضع الصيانة' });
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
      return callback({ success: false, error: 'الموقع في وضع الصيانة' });
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

    addLog('room', `🏠 غرفة جديدة: ${roomId} - ${options.userName}`);
    notifyAdmin('new-room', { roomId, hostName: options.userName, language: options.language, isPrivate: options.isPrivate, timestamp: new Date() });
    notifyAdmin('rooms-update', getRoomsData());
    notifyAdmin('stats-update', { ...stats, activeRooms: rooms.size, activeUsers: io.sockets.sockets.size });

    callback({ success: true, roomId });
  });

  // ==================
  // Join Room
  // ==================
  socket.on('join-room', (data, callback) => {
    if (maintenanceMode) {
      return callback({ success: false, error: 'الموقع في وضع الصيانة' });
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
    socket.to(roomId).emit('partner-joined', { id: socket.id, name: userName, language });

    addLog('room', `👥 ${userName} انضم للغرفة: ${roomId}`);
    notifyAdmin('user-joined-room', { roomId, userName, language, timestamp: new Date() });
    notifyAdmin('rooms-update', getRoomsData());
    notifyAdmin('stats-update', { ...stats, activeRooms: rooms.size, activeUsers: io.sockets.sockets.size });

    callback({
      success: true,
      roomId,
      partner: host && host.id !== socket.id ? { id: host.id, name: host.name, language: host.language } : null,
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
    notifyAdmin('stats-update', { ...stats, activeRooms: rooms.size });
  });

  // ==================
  // Speaking
  // ==================
  socket.on('speaking', (data) => {
    socket.to(data.roomId).emit('partner-speaking', { speaking: data.speaking });
  });

  // ==================
  // AI Chat (Gemini)
  // ==================
  socket.on('ai-chat', async (data, callback) => {
    const { message, language, mode, context } = data;

    try {
      // Get or create context for this socket
      if (!aiContexts.has(socket.id)) {
        aiContexts.set(socket.id, []);
      }
      const history = aiContexts.get(socket.id);

      let systemPrompt = '';

      if (mode === 'language-teacher') {
        // وضع مدرّس اللغة
        const langNames = {
          ar: 'العربية', en: 'English', es: 'Español',
          fr: 'Français', de: 'Deutsch', tr: 'Türkçe',
          zh: '中文', ja: '日本語', ru: 'Русский', pt: 'Português'
        };
        const targetLangName = langNames[context?.targetLang] || 'English';
        const userLangName = langNames[language] || 'Arabic';

        systemPrompt = `You are an expert language teacher helping a student learn ${targetLangName}.
The student's native language is ${userLangName}.

Your role:
1. Respond naturally in ${targetLangName} to practice conversation
2. After your response, add a section starting with "---" that includes:
   - ✅ What the student said correctly
   - ❌ Any mistakes (grammar, vocabulary, pronunciation tips)
   - 💡 Better way to say it (if applicable)
   - 📚 New vocabulary from the conversation
3. Keep responses friendly, encouraging and educational
4. If student writes in their native language, gently encourage them to try in ${targetLangName}
5. Adapt difficulty to the student's level

Always respond in this format:
[Your natural response in ${targetLangName}]
---
✅ [What was correct]
❌ [Mistakes if any]
💡 [Better alternatives]
📚 [New words learned]`;

      } else if (mode === 'translator') {
        // وضع المترجم الذكي
        systemPrompt = `You are an expert translator and cultural advisor.
User's language: ${language}
Help them with translations, cultural insights, and language tips.
Be concise, accurate, and culturally sensitive.
Always provide context and cultural notes when relevant.`;

      } else {
        // وضع المساعد العام
        systemPrompt = `You are a helpful AI assistant for TranslationCall Pro, a real-time translation app.
User's language preference: ${language}
Help users with:
- Translations between any languages
- Cultural tips and insights  
- Language learning advice
- Communication tips
Be friendly, concise, and helpful.
Respond in the same language the user writes in.`;
      }

      // Add user message to history
      history.push({ role: 'user', content: message });

      // Keep history manageable (last 10 messages)
      while (history.length > 10) history.shift();

      // Call Gemini
      const response = await callGemini(history, systemPrompt);

      if (response) {
        // Add assistant response to history
        history.push({ role: 'assistant', content: response });

        // Parse language teacher response
        if (mode === 'language-teacher' && response.includes('---')) {
          const parts = response.split('---');
          callback({
            success: true,
            response: parts[0].trim(),
            feedback: parts[1]?.trim() || null,
            mode
          });
        } else {
          callback({ success: true, response, mode });
        }
      } else {
        callback({
          success: false,
          error: 'عذراً، حدث خطأ في الذكاء الاصطناعي. حاول مرة أخرى.'
        });
      }

    } catch (error) {
      console.error('AI Chat error:', error);
      callback({
        success: false,
        error: 'خطأ في الاتصال بالذكاء الاصطناعي'
      });
    }
  });

  // Clear AI context
  socket.on('ai-clear-context', () => {
    aiContexts.delete(socket.id);
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
    aiContexts.delete(socket.id);
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
    socket.to(roomId).emit('partner-left', { name: participant?.name || 'الشريك' });
    room.status = 'waiting';
    addLog('room', `👋 ${participant?.name} غادر: ${roomId}`);
  }

  notifyAdmin('rooms-update', getRoomsData());
  notifyAdmin('stats-update', { ...stats, activeRooms: rooms.size, activeUsers: io.sockets.sockets.size });
}

// ============================================
// API Routes
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: '✅ TranslationCall Pro Server',
    rooms: rooms.size,
    maintenance: maintenanceMode,
    ai: GEMINI_API_KEY ? '✅ Gemini Connected' : '❌ No API Key'
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

// ============================================
// Start Server
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🎙️  TranslationCall Pro Server         ║
║   🚀 Port: ${PORT}                         ║
║   🤖 Gemini: ${GEMINI_API_KEY ? '✅ Connected' : '❌ Not configured'}        ║
╚══════════════════════════════════════════╝
  `);
});
