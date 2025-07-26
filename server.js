// server.js (Ultimate Version - Handles Image URLs)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;

function getTokenForPage(pageId) {
  const token = process.env[`PAGE_TOKEN_${pageId}`];
  if (!token) {
    console.error(`[Error] ไม่พบ Access Token สำหรับ Page ID: ${pageId} ในไฟล์ .env`);
  }
  return token;
}

const userProfilesCache = {};
async function getUserProfile(userId, pageId) {
    if (userProfilesCache[userId]) return userProfilesCache[userId];
    const accessToken = getTokenForPage(pageId);
    if (!accessToken) return { name: `User ${userId.slice(-4)}`, profile_pic: null };
    try {
        const response = await axios.get(`https://graph.facebook.com/${userId}`, {
            params: { fields: 'name,profile_pic', access_token: accessToken }
        });
        userProfilesCache[userId] = response.data;
        return response.data;
    } catch (error) {
        console.error(`[Error] ไม่สามารถดึงข้อมูลโปรไฟล์ของ User ID ${userId}:`, error.response ? error.response.data.error.message : error.message);
        return { name: `User ${userId.slice(-4)}`, profile_pic: null };
    }
}

app.get('/pages-info', async (req, res) => {
    const pageTokenKeys = Object.keys(process.env).filter(key => key.startsWith('PAGE_TOKEN_'));
    if (pageTokenKeys.length === 0) {
        return res.json([]);
    }
    const pageInfoPromises = pageTokenKeys.map(async (key) => {
        const pageId = key.replace('PAGE_TOKEN_', '');
        const accessToken = process.env[key];
        try {
            const response = await axios.get(`https://graph.facebook.com/${pageId}`, {
                params: { fields: 'name,picture{url}', access_token: accessToken }
            });
            return { id: pageId, name: response.data.name, picture: response.data.picture };
        } catch (error) {
            console.error(`[Error] ไม่สามารถดึงข้อมูลของ Page ID ${pageId}:`, error.response ? error.response.data.error.message : error.message);
            return null;
        }
    });
    try {
        const pagesInfo = (await Promise.all(pageInfoPromises)).filter(p => p !== null);
        res.json(pagesInfo);
    } catch (error) {
        res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูลเพจ' });
    }
});

io.on('connection', (socket) => {
  console.log('[Info] A user connected to WebSocket:', socket.id);
  socket.on('disconnect', () => console.log('[Info] User disconnected:', socket.id));
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Info] WEBHOOK_VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging[0];
      // ตรวจสอบว่ามี message event และไม่ใช่ข้อความจากเพจเอง
      if (webhookEvent.message && !webhookEvent.message.is_echo) {
        const senderId = webhookEvent.sender.id;
        const pageId = webhookEvent.recipient.id;
        const userProfile = await getUserProfile(senderId, pageId);
        
        const messagePayload = webhookEvent.message;
        const eventData = {
            pageId: pageId,
            sender: { id: senderId, name: userProfile.name, profile_pic: userProfile.profile_pic },
            message: {
                mid: messagePayload.mid,
                text: messagePayload.text, // จะเป็น undefined ถ้าเป็นรูปภาพ
                attachments: messagePayload.attachments, // จะมีข้อมูลถ้าเป็นรูปภาพ
                timestamp: webhookEvent.timestamp
            }
        };
        
        console.log('[Info] Emitting facebook-event to frontend:', eventData);
        io.emit('facebook-event', eventData);
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// --- Endpoint สำหรับส่งข้อความ (อัปเกรดให้ส่งรูปได้) ---
app.post('/send-message', async (req, res) => {
    const { psid, message, pageId, messageType = 'text' } = req.body;

    if (!psid || !message || !pageId) {
        return res.status(400).send('Missing required fields: psid, message, pageId');
    }

    const accessToken = getTokenForPage(pageId);
    if (!accessToken) {
        return res.status(500).send(`Token for page ${pageId} not configured.`);
    }

    let messageData;
    if (messageType === 'image') {
        messageData = {
            attachment: {
                type: 'image',
                payload: {
                    url: message,
                    is_reusable: true
                }
            }
        };
    } else {
        messageData = { text: message };
    }

    const requestBody = { 
        recipient: { id: psid }, 
        message: messageData, 
        messaging_type: 'RESPONSE' 
    };

    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${accessToken}`, requestBody);
        res.status(200).send('Message sent successfully');
    } catch (error) {
        console.error("[Error] Failed to send message:", error.response ? error.response.data : error.message);
        res.status(500).send('Failed to send message');
    }
});

http.listen(PORT, () => console.log(`[Info] Server is listening on port ${PORT}`));
