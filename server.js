const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const helpers = require('./helpers'); // Pastikan file helpers.js ada

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 5e6 
});

app.get('/', (req, res) => res.send("AnonChat Server v3.3 (Subnet Ban + E2EE + Fix)"));

const RATE_LIMIT_MS = 500;

// --- DATABASE MEMORY ---
let queue = {};     
let rooms = {};     
let users = {};     
let bannedIPs = new Set(); 
let bannedDevices = new Set();

io.on('connection', (socket) => {
    // 1. Cek Banned Subnet (IP)
    // Menggunakan variabel 'userSubnetHash'
    const userSubnetHash = helpers.getIpHash(socket); 

    if (bannedIPs.has(userSubnetHash)) {
        console.log(`🚫 Blocked connection from banned subnet: ${userSubnetHash}`);
        socket.emit('system_message', '🚫 Akses Ditolak: Jaringan internet Anda diblokir.');
        socket.disconnect(true);
        return;
    }

    io.emit('update_user_count', io.engine.clientsCount);

    const checkDeviceBan = (deviceId) => {
        if (deviceId && bannedDevices.has(deviceId)) {
            socket.emit('system_message', '🚫 Akses Ditolak: Perangkat diblokir.');
            socket.disconnect(true);
            return true; 
        }
        return false; 
    };

    // --- A. RANDOM MATCH (UPDATED: With Alias) ---
    socket.on('find_match', ({ nickname, country, interests, deviceId }) => {
        if(checkDeviceBan(deviceId)) return;

        const interestList = typeof interests === 'string' ? interests.split(',').map(i => i.trim().toLowerCase()).filter(i => i) : [];
        const randomAlias = helpers.generateRoomAlias(); 

        users[socket.id] = { 
            nickname: helpers.escapeHtml(nickname), 
            country, 
            interests: interestList,
            partner: null, 
            mode: 'random',
            roomAlias: randomAlias, 
            lastMessageTime: 0,
            reportCount: 0,
            revealed: false,
            // PERBAIKAN: Gunakan nama properti 'subnetHash' agar konsisten
            subnetHash: userSubnetHash, 
            deviceId: deviceId
        };
        
        if (!queue[country]) queue[country] = [];
        
        if (queue[country].length > 0) {
            const partnerId = queue[country].shift();
            if(users[partnerId]) {
                users[socket.id].partner = partnerId;
                users[partnerId].partner = socket.id;
                
                io.to(socket.id).emit('chat_start', { 
                    role: 'initiator', 
                    mode: 'random', 
                    myAlias: users[socket.id].roomAlias,
                    partnerAlias: users[partnerId].roomAlias 
                });
                
                io.to(partnerId).emit('chat_start', { 
                    role: 'receiver', 
                    mode: 'random',
                    myAlias: users[partnerId].roomAlias,
                    partnerAlias: users[socket.id].roomAlias
                });
            } else {
                queue[country].push(socket.id);
                socket.emit('waiting', `Mencari partner di ${country}...`);
            }
        } else {
            queue[country].push(socket.id);
            socket.emit('waiting', `Mencari partner di ${country}...`);
        }
    });

    // --- B. ROOM LOGIC ---
    socket.on('create_room', ({ nickname, roomId, deviceId, capacity }) => {
        if(checkDeviceBan(deviceId)) return;
        if (rooms[roomId]) return socket.emit('waiting', '❌ Room ID sudah terpakai!');
        
        let maxUsers = parseInt(capacity) || 2;
        if (maxUsers < 2) maxUsers = 2;
        if (maxUsers > 1000) maxUsers = 1000;

        const roomAlias = helpers.generateRoomAlias();

        users[socket.id] = { 
            nickname: helpers.escapeHtml(nickname), 
            mode: 'room', 
            roomId, 
            roomAlias, 
            role: 'Admin', 
            lastMessageTime: 0,
            reportCount: 0,
            // PERBAIKAN: Konsisten menggunakan subnetHash
            subnetHash: userSubnetHash, 
            deviceId: deviceId
        };
        
        rooms[roomId] = { users: [socket.id], max: maxUsers, admin: socket.id };
        socket.join(roomId);
        
        socket.emit('chat_start', { 
            mode: 'room', 
            isGroup: maxUsers > 2, 
            roomName: roomId,
            myRole: 'Admin',
            myAlias: roomAlias
        });
        
        socket.emit('system_message', `✅ Room dibuat. Alias Anda: ${roomAlias}`);
    });

    socket.on('join_room', ({ nickname, roomId, deviceId }) => {
        if(checkDeviceBan(deviceId)) return;

        const room = rooms[roomId];
        if (!room) return socket.emit('waiting', '❌ Room tidak ditemukan.');
        if (room.users.length >= room.max) return socket.emit('waiting', '❌ Room penuh!');

        const roomAlias = helpers.generateRoomAlias();

        users[socket.id] = { 
            nickname: helpers.escapeHtml(nickname), 
            mode: 'room', 
            roomId, 
            roomAlias,
            role: 'Member',
            lastMessageTime: 0,
            reportCount: 0,
            // PERBAIKAN: Konsisten menggunakan subnetHash
            subnetHash: userSubnetHash, 
            deviceId: deviceId
        };
        
        room.users.push(socket.id);
        socket.join(roomId);
        
        socket.emit('chat_start', { 
            mode: 'room', 
            isGroup: room.max > 2, 
            roomName: roomId,
            myRole: 'Member',
            myAlias: roomAlias
        });

        socket.emit('system_message', `✅ Bergabung sebagai ${roomAlias}`);
        socket.to(roomId).emit('system_message', `➕ ${roomAlias} bergabung.`);
        
        if (room.max === 2 && room.users.length === 2) {
            const hostId = room.users[0];
            users[socket.id].partner = hostId;
            users[hostId].partner = socket.id;
            io.to(hostId).emit('p2p_init', { role: 'initiator' });
            io.to(socket.id).emit('p2p_init', { role: 'receiver' });
        }
    });

    // --- C. MESSAGING ---
    socket.on('send_message', (payloadStr) => {
        const user = users[socket.id];
        if (!user) return;

        const now = Date.now();
        if (now - user.lastMessageTime < RATE_LIMIT_MS) return;
        user.lastMessageTime = now;

        try {
            let payload = JSON.parse(payloadStr);
            
            if (payload.type === 'text') {
                let safeContent = helpers.escapeHtml(payload.content);
                // Jika pesan terenkripsi (ENC:...), jangan filter bad words (karena tidak terbaca)
                if (!payload.content.startsWith("ENC:")) {
                    safeContent = helpers.filterBadWords(safeContent);
                }
                payload.content = safeContent;
                
                payload.sender = user.roomAlias; 
                payload.role = user.role || 'User'; 
                payload.realNickname = user.revealed ? user.nickname : null;

                // LOGIKA AUDIO (Updated)
                if (payload.type === 'audio') {
                    payload.sender = user.roomAlias; 
                    payload.role = user.role || 'User';
                    // Tambahkan ini agar ID muncul di Audio jika sudah reveal
                    payload.realNickname = user.revealed ? user.nickname : null;
                    if (user.revealed) {
                        const rawId = user.deviceId || user.subnetHash || "UNKNOWN";
                        payload.senderId = rawId.substring(0, 8).toUpperCase();
                    }
                }

                if (user.revealed) {
                    // PERBAIKAN: Gunakan 'user.subnetHash' (konsisten dengan deklarasi di atas)
                    const rawId = user.deviceId || user.subnetHash || "UNKNOWN";
                    payload.senderId = rawId.substring(0, 8).toUpperCase();
                }
            }

            if (user.mode === 'random' && user.partner) {
                io.to(user.partner).emit('receive_message', JSON.stringify(payload));
            } else if (user.mode === 'room' && user.roomId) {
                socket.to(user.roomId).emit('receive_message', JSON.stringify(payload));
            }

        } catch (e) { console.error("Msg error:", e); }
    });

    // --- D. SIGNALING & E2EE KEY EXCHANGE ---
    socket.on('signal', (data) => {
        const user = users[socket.id];
        if (user && user.partner) io.to(user.partner).emit('signal', data);
    });

    // Listener E2EE (Menukar Kunci Publik)
    socket.on('exchange_key', (keyData) => {
        const user = users[socket.id];
        if (user && user.partner && user.mode === 'random') {
            io.to(user.partner).emit('exchange_key', keyData);
        }
    });

    // --- E. SOCIAL & ADMIN ---
    socket.on('reveal_identity', () => {
        const user = users[socket.id];
        if (!user) return;

        user.revealed = true;
        const msgContent = `🔓 ${user.roomAlias} reveal sebagai: ${user.nickname}`;
        const sysMsg = JSON.stringify({ isSystem: true, content: msgContent });
        
        // PERBAIKAN: Gunakan 'user.subnetHash'
        const shortId = (user.deviceId || user.subnetHash || "UNKNOWN").substring(0, 8).toUpperCase();
        const revealData = { nickname: user.nickname, id: shortId };

        if (user.mode === 'random' && user.partner) {
            io.to(user.partner).emit('receive_message', sysMsg);
            socket.emit('receive_message', sysMsg);
            io.to(user.partner).emit('partner_revealed', revealData);
        } else if (user.mode === 'room') {
            io.to(user.roomId).emit('receive_message', sysMsg);
        }
    });

    socket.on('rate_partner', ({ action }) => {
        const user = users[socket.id];
        if (!user || !user.partner) return;
        const partner = users[user.partner];
        
        if (action === 'report' && partner) {
            partner.reportCount += 1;
            socket.emit('system_message', '🚩 Laporan diterima.');
            if (partner.reportCount >= 3) {
                // PERBAIKAN: Banned menggunakan subnetHash
                bannedIPs.add(partner.subnetHash);
                if (partner.deviceId) bannedDevices.add(partner.deviceId);
                io.sockets.sockets.get(user.partner)?.disconnect(true);
            }
        }
    });

    // --- F. DISCONNECT ---
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            if (user.mode === 'random') {
                if (queue[user.country]) queue[user.country] = queue[user.country].filter(id => id !== socket.id);
                if (user.partner && users[user.partner]) {
                    io.to(user.partner).emit('partner_left');
                    users[user.partner].partner = null;
                }
            }
            else if (user.mode === 'room' && user.roomId && rooms[user.roomId]) {
                const r = rooms[user.roomId];
                if(r) {
                    r.users = r.users.filter(id => id !== socket.id);
                    socket.to(user.roomId).emit('system_message', `➖ ${user.roomAlias} keluar.`);
                    if (r.users.length === 0) delete rooms[user.roomId]; 
                    else if (r.admin === socket.id) {
                        r.admin = r.users[0];
                        if(users[r.admin]) {
                            users[r.admin].role = 'Admin';
                            io.to(r.admin).emit('system_message', '👑 Anda sekarang adalah Admin Room!');
                        }
                    }
                }
            }
            delete users[socket.id];
        }
        io.emit('update_user_count', io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running port ${PORT}`));
