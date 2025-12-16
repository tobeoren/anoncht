const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Konfigurasi CORS (Agar bisa diakses dari mana saja) & Limit File 5MB
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 5e6 
});

app.get('/', (req, res) => {
    res.send("Server AnonChat Hybrid (Random + Room) is Running.");
});

// --- DATABASE MEMORY ---
let queue = {}; // Antrean Random: { 'Indonesia': [id1, id2] }
let users = {}; // Data User
let bannedIPs = new Set(); 

// Helper: Hash IP (Privasi)
function getIpHash(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return crypto.createHash('sha256').update(ip).digest('hex');
}

// Helper: Anti XSS
function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}

io.on('connection', (socket) => {
    // 1. CEK STATUS BANNED
    const userIpHash = getIpHash(socket);
    if (bannedIPs.has(userIpHash)) {
        socket.emit('system_message', '🚫 Perangkat Anda diblokir permanen.');
        socket.disconnect(true);
        return;
    }

    io.emit('update_user_count', io.engine.clientsCount);

    // --- FITUR A: RANDOM MATCHMAKING ---
    // Nama event diubah jadi 'find_random_match' untuk spesifik
    socket.on('find_random_match', ({ nickname, country, interests }) => {
        resetUserState(socket); // Bersihkan status lama

        users[socket.id] = { 
            nickname: escapeHtml(nickname), 
            country, 
            interests: typeof interests === 'string' ? interests.toLowerCase().split(',') : [],
            mode: 'random',
            partner: null,
            ipHash: userIpHash,
            reportCount: 0
        };

        findRandomPartner(socket.id, country, users[socket.id].interests);
    });

    function findRandomPartner(socketId, country, myInterests) {
        if (!queue[country]) queue[country] = [];
        let matchIndex = -1;

        // Cek Minat Sama
        if (myInterests.length > 0) {
            matchIndex = queue[country].findIndex(id => {
                const waiter = users[id];
                return waiter && waiter.interests.some(x => myInterests.includes(x));
            });
        }
        // Fallback: Ambil Siapa Saja
        if (matchIndex === -1 && queue[country].length > 0) matchIndex = 0;

        if (matchIndex > -1) {
            const partnerId = queue[country].splice(matchIndex, 1)[0];
            
            if (users[partnerId]) {
                // Saling Link
                users[socketId].partner = partnerId;
                users[partnerId].partner = socketId;
                
                io.to(socketId).emit('chat_start', { mode: 'random', role: 'initiator' });
                io.to(partnerId).emit('chat_start', { mode: 'random', role: 'receiver' });
            } else {
                findRandomPartner(socketId, country, myInterests); // Retry
            }
        } else {
            queue[country].push(socketId);
            socket.emit('waiting', `Mencari partner random di ${country}...`);
        }
    }

    // --- FITUR B: ROOM CHAT ---
    socket.on('join_room', ({ roomCode, nickname }) => {
        resetUserState(socket);

        const roomID = roomCode.trim().toUpperCase();
        socket.join(roomID);
        
        users[socket.id] = { 
            nickname: escapeHtml(nickname), 
            room: roomID, 
            mode: 'room', 
            ipHash: userIpHash,
            reportCount: 0
        };

        socket.to(roomID).emit('system_message', `👋 ${nickname} bergabung.`);
        
        // Fitur Sync History (P2P Relay)
        const clients = io.sockets.adapter.rooms.get(roomID);
        if (clients && clients.size > 1) {
            const otherSocketId = [...clients].find(id => id !== socket.id);
            if(otherSocketId) io.to(otherSocketId).emit('request_history_sync', { requesterId: socket.id });
        }
        
        socket.emit('chat_start', { mode: 'room', roomName: roomID });
    });

    // --- UNIVERSAL MESSAGING (Teks/File/Voice) ---
    socket.on('send_message', (data) => {
        const user = users[socket.id];
        if (!user) return;

        const payload = {
            msg: data.msg,
            sender: user.nickname,
            type: data.type || 'text',
            fileData: data.fileData,
            timer: data.timer // Fitur Burn Message
        };

        // Kirim sesuai mode user (Random / Room)
        if (user.mode === 'random' && user.partner) {
            io.to(user.partner).emit('receive_message', payload);
        } else if (user.mode === 'room' && user.room) {
            socket.to(user.room).emit('receive_message', payload);
        }
    });

    // --- E2EE KEY EXCHANGE ---
    socket.on('signal_key', (keyData) => {
        const user = users[socket.id];
        if (!user) return;

        if (user.mode === 'random' && user.partner) {
            io.to(user.partner).emit('signal_key', keyData);
        } else if (user.mode === 'room' && user.room) {
            socket.to(user.room).emit('signal_key', { key: keyData, senderId: socket.id });
        }
    });

    // --- DATA SYNC (ROOM) ---
    socket.on('send_history_data', ({ targetId, history }) => {
        io.to(targetId).emit('receive_history_sync', history);
    });

    // --- REPORT SYSTEM ---
    socket.on('report_partner', () => {
        const user = users[socket.id];
        let targetId = user.mode === 'random' ? user.partner : null; 
        
        if(targetId && users[targetId]) {
            users[targetId].reportCount++;
            socket.emit('system_message', '🚩 Laporan diterima.');
            // Auto Ban jika > 3 report
            if(users[targetId].reportCount >= 3) {
                bannedIPs.add(users[targetId].ipHash);
                io.sockets.sockets.get(targetId)?.disconnect(true);
            }
        }
    });

    // --- UTILS (Typing/Reveal/Disconnect) ---
    socket.on('typing', () => {
        const user = users[socket.id];
        if(!user) return;
        if (user.mode === 'random' && user.partner) io.to(user.partner).emit('partner_typing');
        else if (user.mode === 'room' && user.room) socket.to(user.room).emit('partner_typing');
    });

    socket.on('stop_typing', () => {
        const user = users[socket.id];
        if(!user) return;
        if (user.mode === 'random' && user.partner) io.to(user.partner).emit('partner_stop_typing');
        else if (user.mode === 'room' && user.room) socket.to(user.room).emit('partner_stop_typing');
    });

    socket.on('reveal_identity', () => {
        const user = users[socket.id];
        if (user && user.mode === 'random' && user.partner) {
            io.to(user.partner).emit('partner_revealed', { nickname: user.nickname });
        }
    });

    socket.on('disconnect', () => {
        resetUserState(socket);
        delete users[socket.id];
        io.emit('update_user_count', io.engine.clientsCount);
    });
});

// Helper Membersihkan State
function resetUserState(socket) {
    const user = users[socket.id];
    if (user) {
        if (user.mode === 'random') {
            if (queue[user.country]) queue[user.country] = queue[user.country].filter(id => id !== socket.id);
            if (user.partner) {
                io.to(user.partner).emit('partner_left');
                const partner = users[user.partner];
                if(partner) partner.partner = null;
            }
        } else if (user.mode === 'room') {
            socket.to(user.room).emit('system_message', `❌ ${user.nickname} keluar.`);
            socket.leave(user.room);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Hybrid running on ${PORT}`));
