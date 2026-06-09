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
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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
      id:p.id, name:p.name, language:p.language, joinedAt:p.joinedAt
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
    const room = {
      id:roomId, hostId:socket.id,
      isPrivate:options.isPrivate||false,
      password:options.password||null,
      participants:new Map(),
      messages:[], createdAt:new Date(), status:'waiting'
    };

    room.participants.set(socket.id, {
      id:socket.id, name:options.userName||'مضيف',
      language:options.language||'ar',
      isHost:true, joinedAt:new Date()
    });

    rooms.set(roomId, room);
    socket.join(roomId);
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

    const {roomId, userName, language, password} = data;
    const room = rooms.get(roomId);

    if(!room) return callback({success:false, error:'الغرفة غير موجودة'});
    if(room.participants.size>=2 && !room.participants.has(socket.id))
      return callback({success:false, error:'الغرفة ممتلئة'});
    if(room.isPrivate && room.password!==password && !room.participants.has(socket.id))
      return callback({success:false, error:'كلمة المرور غير صحيحة'});

    if(!room.participants.has(socket.id)){
      room.participants.set(socket.id, {
        id:socket.id, name:userName, language,
        isHost:false, joinedAt:new Date()
      });
    }

    room.status = 'active';
    socket.join(roomId);
    stats.totalUsers++;
    if(language) stats.languages[language] = (stats.languages[language]||0)+1;

    const host = room.participants.get(room.hostId);
    socket.to(roomId).emit('partner-joined', {id:socket.id, name:userName, language});

    addLog('room', `👥 ${userName} انضم: ${roomId}`);
    notifyAdmin('rooms-update', getRoomsData());
    notifyAdmin('stats-update', getStatsData());

    callback({
      success:true, roomId,
      partner: host && host.id!==socket.id ? {id:host.id, name:host.name, language:host.language} : null,
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
  // Speaking
  // ==================
  socket.on('speaking', (data) => {
    socket.to(data.roomId).emit('partner-speaking', {speaking:data.speaking});
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
        systemPrompt = `You are an expert language teacher helping a student learn ${targetLangName}. The student's native language is ${userLangName}. Respond in ${targetLangName}. After your response, add --- then feedback: ✅ correct, ❌ mistakes, 💡 better alternatives, 📚 new vocabulary.`;
      }else if(mode==='translator'){
        systemPrompt = `You are an expert translator. User language: ${language}. Help with translations and cultural insights. Be concise and accurate.`;
      }else{
        systemPrompt = `You are a helpful AI assistant for TranslationCall Pro. User language: ${language}. Help with translations, cultural tips, and language learning. Be friendly and concise. Respond in the user's language.`;
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
  socket.on('leave-room', (data) => { handleLeave(socket, data.roomId); });

  // ==================
  // Disconnect
  // ==================
  socket.on('disconnect', () => {
    if(socket.isAdmin){ adminSocket=null; }
    aiContexts.delete(socket.id);
    rooms.forEach((room, roomId) => {
      if(room.participants.has(socket.id)) handleLeave(socket, roomId);
    });
  });
});

// ============================================
// Handle Leave
// ============================================
function handleLeave(socket, roomId){
  const room = rooms.get(roomId);
  if(!room) return;
  const participant = room.participants.get(socket.id);
  room.participants.delete(socket.id);
  socket.leave(roomId);
  if(room.participants.size===0){
    rooms.delete(roomId);
    addLog('room', `🗑️ انتهت: ${roomId}`);
  }else{
    socket.to(roomId).emit('partner-left', {name:participant?.name||'الشريك'});
    room.status = 'waiting';
    addLog('room', `👋 ${participant?.name} غادر: ${roomId}`);
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
