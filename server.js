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
const ADMIN_PASSWORD_HASH = crypto.createHash('sha256').update('Oadmin@111').digest('hex');
const SITE_CODE_HASH = crypto.createHash('sha256').update('Nimer0787691975').digest('hex');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

let adminSocket = null;

// ============================================
// Database
// ============================================
const rooms = new Map();
const blockedUsers = new Set();
const activityLog = [];
const aiContexts = new Map();
const stats = { totalRooms:0, totalMessages:0, totalUsers:0, languages:{} };
let maintenanceMode = false;

// ✅ Grace period for reconnection (30 seconds)
const disconnectTimers = new Map();
const GRACE_PERIOD = 30000;

// ============================================
// Helpers
// ============================================
function generateCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i=0;i<6;i++) code += chars.charAt(Math.floor(Math.random()*chars.length));
  return rooms.has(code) ? generateCode() : code;
}

function addLog(type, message){
  const entry = { id:uuidv4(), type, message, timestamp:new Date() };
  activityLog.unshift(entry);
  if(activityLog.length>100) activityLog.pop();
  if(adminSocket) adminSocket.emit('new-log', entry);
  return entry;
}

function notifyAdmin(event, data){
  if(adminSocket) adminSocket.emit(event, data);
}

function getRoomsData(){
  return Array.from(rooms.values()).map(room=>({
    id:room.id, isPrivate:room.isPrivate, status:room.status,
    participants:Array.from(room.participants.values()).map(p=>({
      id:p.id, clientId:p.clientId, name:p.name, language:p.language, joinedAt:p.joinedAt
    })),
    createdAt:room.createdAt, messageCount:room.messages.length
  }));
}

function getStatsData(){
  return {
    ...stats,
    activeRooms:rooms.size,
    activeUsers:io.sockets.sockets.size,
    blockedUsers:blockedUsers.size,
    maintenanceMode
  };
}

// ✅ Find participant by clientId
function findParticipantByClientId(roomId, clientId){
  const room = rooms.get(roomId);
  if(!room) return null;
  for(const [socketId, p] of room.participants){
    if(p.clientId === clientId) return { socketId, participant: p };
  }
  return null;
}

// ============================================
// Gemini AI
// ============================================
async function callGemini(messages, systemPrompt){
  try{
    const contents = [];
    if(systemPrompt){
      contents.push({ role:'user', parts:[{text:systemPrompt}] });
      contents.push({ role:'model', parts:[{text:'Understood! I will follow these instructions.'}] });
    }
    messages.forEach(msg=>{
      contents.push({ role:msg.role==='user'?'user':'model', parts:[{text:msg.content}] });
    });

    const response = await fetch(GEMINI_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        contents,
        generationConfig:{ temperature:0.7, topK:40, topP:0.95, maxOutputTokens:1024 }
      })
    });

    const data = await response.json();
    if(data.candidates && data.candidates[0]){
      return data.candidates[0].content.parts[0].text;
    }
    console.error('Gemini no candidates:', JSON.stringify(data));
    return null;
  }catch(error){
    console.error('Gemini error:', error);
    return null;
  }
}

// ============================================
// Socket Events
// ============================================
io.on('connection', (socket) => {
  console.log(`✅ Connected: ${socket.id}`);

  // ==================
  // Site Access Code
  // ==================
  socket.on('verify-site-code', (data, callback) => {
    const hash = crypto.createHash('sha256').update(data.code || '').digest('hex');
    if(hash === SITE_CODE_HASH){
      callback({ success:true });
    }else{
      callback({ success:false, error:'كود الموقع غير صحيح' });
      addLog('warning', '⚠️ محاولة دخول بكود خاطئ');
    }
  });

  // ==================
  // Admin
  // ==================
  socket.on('admin-login', (data, callback) => {
    const hash = crypto.createHash('sha256').update(data.password).digest('hex');
    if(hash === ADMIN_PASSWORD_HASH){
      adminSocket = socket;
      socket.isAdmin = true;
      callback({
        success:true, stats:getStatsData(),
        rooms:getRoomsData(), logs:activityLog,
        maintenanceMode, blockedList:Array.from(blockedUsers)
      });
      addLog('admin', '✅ المسؤول دخل');
    }else{
      callback({ success:false, error:'كلمة المرور غير صحيحة' });
    }
  });

  socket.on('admin-block-user', (data, callback) => {
    if(!socket.isAdmin) return;
    blockedUsers.add(data.userId);
    const s = io.sockets.sockets.get(data.userId);
    if(s){ s.emit('blocked',{message:'تم حظرك'}); s.disconnect(); }
    addLog('admin', `🚫 حظر: ${data.userName||data.userId}`);
    callback({success:true});
    notifyAdmin('stats-update', getStatsData());
  });

  socket.on('admin-unblock-user', (data, callback) => {
    if(!socket.isAdmin) return;
    blockedUsers.delete(data.userId);
    addLog('admin', `✅ رفع حظر: ${data.userId}`);
    callback({success:true});
  });

  socket.on('admin-delete-room', (data, callback) => {
    if(!socket.isAdmin) return;
    const room = rooms.get(data.roomId);
    if(room){
      io.to(data.roomId).emit('room-deleted',{message:'تم حذف الغرفة'});
      rooms.delete(data.roomId);
      addLog('admin', `🗑️ حذف غرفة: ${data.roomId}`);
      callback({success:true});
      notifyAdmin('rooms-update', getRoomsData());
    }else{
      callback({success:false, error:'الغرفة غير موجودة'});
    }
  });

  socket.on('admin-send-warning', (data, callback) => {
    if(!socket.isAdmin) return;
    const s = io.sockets.sockets.get(data.userId);
    if(s){
      s.emit('admin-warning',{message:data.message});
      addLog('admin', `⚠️ تحذير لـ: ${data.userName}`);
      callback({success:true});
    }else{
      callback({success:false, error:'غير متصل'});
    }
  });

  socket.on('admin-toggle-maintenance', (data, callback) => {
    if(!socket.isAdmin) return;
    maintenanceMode = data.enabled;
    addLog('admin', `🔧 صيانة: ${maintenanceMode?'مفعل':'معطل'}`);
    callback({success:true, maintenanceMode});
    if(maintenanceMode){
      io.sockets.sockets.forEach(s=>{
        if(!s.isAdmin){ s.emit('maintenance',{message:'الموقع في صيانة'}); s.disconnect(); }
      });
    }
  });

  socket.on('admin-get-stats', (callback) => {
    if(!socket.isAdmin) return;
    callback(getStatsData());
  });

  // ==================
  // Blocked / Maintenance Check
  // ==================
  if(blockedUsers.has(socket.id)){
    socket.emit('blocked',{message:'تم حظرك'});
    socket.disconnect();
    return;
  }
  if(maintenanceMode && !socket.isAdmin){
    socket.emit('maintenance',{message:'الموقع في صيانة'});
    socket.disconnect();
    return;
  }

  // ==================
  // Create Room
  // ==================
  socket.on('create-room', (options, callback) => {
    if(maintenanceMode) return callback({success:false, error:'صيانة'});

    const roomId = generateCode();
    const clientId = options.clientId || uuidv4();
    const room = {
      id:roomId, hostId:socket.id, hostClientId:clientId,
      isPrivate:options.isPrivate||false,
      password:options.password||null,
      participants:new Map(),
      messages:[], createdAt:new Date(), status:'waiting'
    };

    room.participants.set(socket.id, {
      id:socket.id, clientId,
      name:options.userName||'مضيف',
      language:options.language||'ar',
      isHost:true, joinedAt:new Date()
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.clientId = clientId;
    socket.currentRoom = roomId;
    stats.totalRooms++;
    stats.totalUsers++;
    if(options.language) stats.languages[options.language] = (stats.languages[options.language]||0)+1;

    addLog('room', `🏠 غرفة: ${roomId} - ${options.userName}`);
    notifyAdmin('new-room', {roomId, hostName:options.userName, timestamp:new Date()});
    notifyAdmin('rooms-update', getRoomsData());
    notifyAdmin('stats-update', getStatsData());

    callback({success:true, roomId});
  });

  // ==================
  // Join Room
  // ==================
  socket.on('join-room', (data, callback) => {
    if(maintenanceMode) return callback({success:false, error:'صيانة'});

    const {roomId, userName, language, password, clientId} = data;
    const room = rooms.get(roomId);

    if(!room) return callback({success:false, error:'الغرفة غير موجودة'});

    // ✅ Check if this clientId is already in the room (reconnecting)
    const existing = clientId ? findParticipantByClientId(roomId, clientId) : null;

    if(existing){
      // Reconnecting - update socket id
      room.participants.delete(existing.socketId);
      room.participants.set(socket.id, {
        ...existing.participant,
        id: socket.id
      });
      socket.join(roomId);
      socket.clientId = clientId;
      socket.currentRoom = roomId;

      // Cancel disconnect timer if exists
      const timerKey = `${roomId}-${clientId}`;
      if(disconnectTimers.has(timerKey)){
        clearTimeout(disconnectTimers.get(timerKey));
        disconnectTimers.delete(timerKey);
        console.log(`🔄 Reconnected: ${userName} in ${roomId}`);
      }

      // Get partner
      let partner = null;
      for(const [sid, p] of room.participants){
        if(sid !== socket.id){ partner = p; break; }
      }

      // Notify partner that we're back
      socket.to(roomId).emit('partner-reconnected', {
        id: socket.id,
        name: userName,
        language
      });

      callback({
        success:true, roomId,
        partner: partner ? {id:partner.id, name:partner.name, language:partner.language} : null,
        messages: room.messages,
        reconnected: true
      });
      return;
    }

    // New join
    if(room.participants.size >= 2)
      return callback({success:false, error:'الغرفة ممتلئة'});
    if(room.isPrivate && room.password !== password)
      return callback({success:false, error:'كلمة المرور غير صحيحة'});

    const newClientId = clientId || uuidv4();

    room.participants.set(socket.id, {
      id:socket.id, clientId:newClientId,
      name:userName, language,
      isHost:false, joinedAt:new Date()
    });

    room.status = 'active';
    socket.join(roomId);
    socket.clientId = newClientId;
    socket.currentRoom = roomId;
    stats.totalUsers++;
    if(language) stats.languages[language] = (stats.languages[language]||0)+1;

    // Get host
    let host = null;
    for(const [sid, p] of room.participants){
      if(sid !== socket.id){ host = p; break; }
    }

    socket.to(roomId).emit('partner-joined', {id:socket.id, name:userName, language});

    addLog('room', `👥 ${userName} انضم: ${roomId}`);
    notifyAdmin('rooms-update', getRoomsData());
    notifyAdmin('stats-update', getStatsData());

    callback({
      success:true, roomId,
      partner: host ? {id:host.id, name:host.name, language:host.language} : null,
      messages: room.messages
    });
  });

  // ==================
  // Voice Message
  // ==================
  socket.on('voice-message', (data) => {
    const room = rooms.get(data.roomId);
    if(!room) return;
    const message = {
      id:uuidv4(), senderId:socket.id,
      senderName:data.senderName, senderLanguage:data.senderLanguage,
      targetLanguage:data.targetLanguage,
      originalText:data.originalText, translatedText:data.translatedText,
      timestamp:new Date(), type:'voice'
    };
    room.messages.push(message);
    stats.totalMessages++;
    io.to(data.roomId).emit('new-message', message);
  });

  // ==================
  // ✅ Text Message (NEW)
  // ==================
  socket.on('text-message', (data) => {
    const room = rooms.get(data.roomId);
    if(!room) return;
    const message = {
      id:uuidv4(), senderId:socket.id,
      senderName:data.senderName, senderLanguage:data.senderLanguage,
      targetLanguage:data.targetLanguage,
      originalText:data.originalText, translatedText:data.translatedText,
      timestamp:new Date(), type:'text'
    };
    room.messages.push(message);
    stats.totalMessages++;
    io.to(data.roomId).emit('new-message', message);
  });

  // ==================
  // Speaking
  // ==================
  socket.on('speaking', (data) => {
    socket.to(data.roomId).emit('partner-speaking', {speaking:data.speaking});
  });

  // ==================
  // ✅ Live Typing Indicator (NEW)
  // ==================
  socket.on('typing', (data) => {
    socket.to(data.roomId).emit('partner-typing', {
      typing:data.typing,
      text:data.text || ''
    });
  });

  // ==================
  // ✅ Interim Speech (Live text while speaking) (NEW)
  // ==================
  socket.on('interim-speech', (data) => {
    socket.to(data.roomId).emit('partner-interim-speech', {
      text:data.text
    });
  });

  // ==================
  // WebRTC Signaling
  // ==================
  socket.on('rtc-offer', (data) => {
    socket.to(data.roomId).emit('rtc-offer', {offer:data.offer});
  });
  socket.on('rtc-answer', (data) => {
    socket.to(data.roomId).emit('rtc-answer', {answer:data.answer});
  });
  socket.on('rtc-ice', (data) => {
    socket.to(data.roomId).emit('rtc-ice', {candidate:data.candidate});
  });
  socket.on('partner-camera-toggle', (data) => {
    socket.to(data.roomId).emit('partner-camera-toggle', {enabled:data.enabled});
  });

  // ==================
  // AI Chat
  // ==================
  socket.on('ai-chat', async (data, callback) => {
    const {message, language, mode, context} = data;
    try{
      if(!aiContexts.has(socket.id)) aiContexts.set(socket.id, []);
      const history = aiContexts.get(socket.id);

      let systemPrompt = '';
      const langNames = {ar:'العربية',en:'English',es:'Español',fr:'Français',de:'Deutsch',tr:'Türkçe',zh:'中文',ja:'日本語',ru:'Русский',pt:'Português'};

      if(mode==='language-teacher'){
  const targetLangName = langNames[context?.targetLang] || 'English';
  const userLangName = langNames[language] || 'Arabic';
  const level = context?.level || 'A1';
  const scenario = context?.scenario || 'general';

  const scenarios = {
    general: 'general conversation',
    restaurant: 'ordering food at a restaurant',
    airport: 'at the airport and traveling',
    work: 'professional work environment',
    shopping: 'shopping at a store',
    meeting: 'meeting new people and introducing yourself',
    hotel: 'checking into a hotel',
    doctor: 'at the doctor or hospital',
    phone: 'phone conversations',
    directions: 'asking for and giving directions'
  };

  const scenarioDesc = scenarios[scenario] || 'general conversation';
  const levelDesc = {
    'A1': 'complete beginner - use very simple words and short sentences',
    'A2': 'elementary - use simple vocabulary and basic grammar',
    'B1': 'intermediate - use moderate vocabulary and varied sentences',
    'B2': 'upper-intermediate - use rich vocabulary and complex structures',
    'C1': 'advanced - use sophisticated vocabulary and nuanced expressions'
  }[level] || 'beginner';

  systemPrompt = `You are an expert, encouraging ${targetLangName} language teacher.
Student's native language: ${userLangName}
Student's level: ${level} (${levelDesc})
Scenario: ${scenarioDesc}

Your teaching approach:
1. Respond NATURALLY in ${targetLangName} as if you are in the scenario
2. Keep responses appropriate for ${level} level
3. After EVERY response, add "---FEEDBACK---" then provide:
   ✅ What was correct (be specific)
   ❌ Mistakes found (grammar, vocabulary, spelling)
   💡 Better way to say it (if applicable)
   📚 New word/phrase learned today
   🎯 Next challenge: give them a question or task to respond to
4. Be encouraging and warm
5. If student writes in their native language, gently redirect them to practice ${targetLangName}
6. Adapt difficulty to their ${level} level

IMPORTANT: Always end with a question or prompt to keep the conversation going.`;

}else if(mode==='correction'){
  const targetLangName = langNames[context?.targetLang] || 'English';
  const userLangName = langNames[language] || 'Arabic';
  
  systemPrompt = `You are a precise ${targetLangName} language corrector.
Student's native language: ${userLangName}

For each message the student sends:
1. First show the CORRECTED version
2. Then explain each correction clearly
3. Give the rule behind each correction
4. Show example sentences
5. Rate their overall accuracy (1-10)

Format your response as:
✅ Corrected: [corrected sentence]
📝 Corrections:
- [original] → [corrected]: [explanation]
📖 Rule: [grammar rule]
💡 Examples: [2-3 example sentences]
⭐ Accuracy: [X/10]`;

}else if(mode==='conversation'){
  const targetLangName = langNames[context?.targetLang] || 'English';
  const scenario = context?.scenario || 'general';
  const level = context?.level || 'A1';

  systemPrompt = `You are a native ${targetLangName} speaker having a natural conversation.
Scenario: ${scenario}
Student level: ${level}

Rules:
1. Respond ONLY in ${targetLangName}
2. Keep responses natural and conversational
3. Match the level complexity
4. Ask follow-up questions to keep conversation flowing
5. If student makes errors, subtly use the correct form in your response without explicitly correcting
6. Be friendly and engaging`;

}else if(mode==='translator'){
  systemPrompt = `You are an expert translator and cultural advisor.
User language: ${language}.
Help with translations, cultural insights, idioms, and language tips.
Be concise, accurate, and culturally sensitive.
Always provide context and cultural notes when relevant.
Respond in ${language}.`;

}else{
  systemPrompt = `You are a helpful AI assistant for TranslationCall Pro.
User language: ${language}.
Help with translations, cultural tips, and language learning.
Be friendly and concise. Respond in the user's language.`;
}

      history.push({role:'user', content:message});
      while(history.length>10) history.shift();

      const response = await callGemini(history, systemPrompt);

      if(response){
        history.push({role:'assistant', content:response});
        if(mode==='language-teacher' && response.includes('---')){
          const parts = response.split('---');
          callback({success:true, response:parts[0].trim(), feedback:parts[1]?.trim()||null, mode});
        }else{
          callback({success:true, response, mode});
        }
      }else{
        callback({success:false, error:'خطأ في Gemini AI'});
      }
    }catch(error){
      console.error('AI error:', error);
      callback({success:false, error:'خطأ في الاتصال بالذكاء الاصطناعي'});
    }
  });

  socket.on('ai-clear-context', () => { aiContexts.delete(socket.id); });

  // ==================
  // Leave Room
  // ==================
  socket.on('leave-room', (data) => {
    handleLeave(socket, data.roomId, false);
  });

  // ==================
  // ✅ Disconnect with Grace Period
  // ==================
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${socket.id}`);

    if(socket.isAdmin){ adminSocket=null; }
    aiContexts.delete(socket.id);

    // ✅ Don't remove immediately - give grace period for reconnection
    if(socket.currentRoom && socket.clientId){
      const roomId = socket.currentRoom;
      const clientId = socket.clientId;
      const timerKey = `${roomId}-${clientId}`;

      // Notify partner that we might be disconnecting
      socket.to(roomId).emit('partner-connection-unstable', {
        message: 'قد يكون شريكك يعيد الاتصال...'
      });

      console.log(`⏳ Grace period started for ${clientId} in ${roomId}`);

      // Wait GRACE_PERIOD before actually removing
      const timer = setTimeout(() => {
        console.log(`⏰ Grace period expired for ${clientId} in ${roomId}`);
        disconnectTimers.delete(timerKey);
        handleLeave(socket, roomId, true);
      }, GRACE_PERIOD);

      disconnectTimers.set(timerKey, timer);
    }else{
      // No room - just clean up
      rooms.forEach((room, roomId) => {
        if(room.participants.has(socket.id)){
          handleLeave(socket, roomId, true);
        }
      });
    }
  });
});

// ============================================
// Handle Leave
// ============================================
function handleLeave(socket, roomId, isDisconnect){
  const room = rooms.get(roomId);
  if(!room) return;

  const participant = room.participants.get(socket.id);
  if(!participant && isDisconnect){
    // Maybe already removed or reconnected
    return;
  }

  if(participant){
    room.participants.delete(socket.id);
  }

  try{ socket.leave(roomId); }catch(e){}

  if(room.participants.size === 0){
    rooms.delete(roomId);
    addLog('room', `🗑️ انتهت: ${roomId}`);
  }else{
    io.to(roomId).emit('partner-left', {name:participant?.name||'الشريك'});
    room.status = 'waiting';
    addLog('room', `👋 ${participant?.name||'?'} غادر: ${roomId}`);
  }

  notifyAdmin('rooms-update', getRoomsData());
  notifyAdmin('stats-update', getStatsData());
}

// ============================================
// API
// ============================================
app.get('/', (req, res) => {
  res.json({
    status:'✅ TranslationCall Pro Server',
    rooms:rooms.size,
    maintenance:maintenanceMode,
    ai:GEMINI_API_KEY?'✅ Gemini Connected':'❌ No API Key'
  });
});

app.get('/room/:roomId', (req, res) => {
  const room = rooms.get(req.params.roomId);
  if(room){
    res.json({exists:true, isPrivate:room.isPrivate, isFull:room.participants.size>=2, participants:room.participants.size, status:room.status});
  }else{
    res.json({exists:false});
  }
});

// ============================================
// Start
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎙️ TranslationCall Pro Server on port ${PORT}`);
  console.log(`🤖 Gemini: ${GEMINI_API_KEY?'✅':'❌'}`);
});
