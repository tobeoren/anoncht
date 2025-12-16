const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Konfigurasi CORS & Limit Payload
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 5e6 // Limit 5MB
});

app.get('/', (req, res) => res.send("Server Hybrid (Random + Room) Berjalan."));

// --- DATABASE MEMORY ---
let queue = {}; // Random Queue
let users = {}; // User Data
let bannedIPs = new Set(); 

function getIpHash(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return crypto.createHash('sha256').update(ip).digest('hex');
}

function escapeHtml(text) {
    return text ? text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]) : text;
}

io.on('connection', (socket) => {
    const userIpHash = getIpHash(socket);

    // 1. CEK BANNED
    if (bannedIPs.has(userIpHash)) {
        socket.emit('system_message', '🚫 Akses Ditolak: Perangkat diblokir.');
        socket.disconnect(true);
        return;
    }

    io.emit('update_user_count', io.engine.clientsCount);

    // --- MODE A: RANDOM MATCHMAKING (PERBAIKAN NAMA EVENT) ---
    // Di app.js emit 'find_random_match', jadi disini harus sama
    socket.on('find_random_match', ({ nickname, country, interests }) => {
        leaveCurrentState(socket); // Keluar dari room/queue sebelumnya

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

        // Prioritas: Minat Sama
        if (myInterests.length > 0) {
            matchIndex = queue[country].findIndex(id => {
                const waiter = users[id];
                return waiter && waiter.interests.some(x => myInterests.includes(x));
            });
        }
        // Fallback: Siapa saja
        if (matchIndex === -1 && queue[country].length > 0) matchIndex = 0;

        if (matchIndex > -1) {
            const partnerId = queue[country].splice(matchIndex, 1)[0];
            if (users[partnerId]) {
                users[socketId].partner = partnerId;
                users[partnerId].partner = socketId;
                
                io.to(socketId).emit('chat_start', { mode: 'random', role: 'initiator' });
                io.to(partnerId).emit('chat_start', { mode: 'random', role: 'receiver' });
            } else {
                findRandomPartner(socketId, country, myInterests);
            }
        } else {
            queue[country].push(socketId);
            socket.emit('waiting', `Mencari partner random di ${country}...`);
        }
    }

    // --- MODE B: ROOM CHAT ---
    socket.on('join_room', ({ roomCode, nickname }) => {
        leaveCurrentState(socket);

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
        
        // P2P Sync Trigger
        const clients = io.sockets.adapter.rooms.get(roomID);
        if (clients && clients.size > 1) {
            const otherSocketId = [...clients].find(id => id !== socket.id);
            if(otherSocketId) io.to(otherSocketId).emit('request_history_sync', { requesterId: socket.id });
        }
        
        socket.emit('chat_start', { mode: 'room', roomName: roomID });
    });

    // --- UNIVERSAL MESSAGING ---
    socket.on('send_message', (data) => {
        const user = users[socket.id];
        if (!user) return;

        const payload = {
            msg: data.msg,
            sender: user.nickname,
            type: data.type || 'text',
            fileData: data.fileData,
            timer: data.timer
        };

        if (user.mode === 'random' && user.partner) {
            io.to(user.partner).emit('receive_message', payload);
        } else if (user.mode === 'room' && user.room) {
            socket.to(user.room).emit('receive_message', payload);
        }
    });

    // --- E2EE & REPORT ---
    socket.on('signal_key', (keyData) => {
        const user = users[socket.id];
        if (!user) return;
        if (user.mode === 'random' && user.partner) io.to(user.partner).emit('signal_key', keyData);
        else if (user.mode === 'room' && user.room) socket.to(user.room).emit('signal_key', { key: keyData, senderId: socket.id });
    });

    socket.on('send_history_data', ({ targetId, history }) => {
        io.to(targetId).emit('receive_history_sync', history);
    });

    socket.on('report_partner', () => {
        const user = users[socket.id];
        let targetId = user.mode === 'random' ? user.partner : null; 
        if(targetId && users[targetId]) {
            users[targetId].reportCount++;
            socket.emit('system_message', '🚩 Laporan diterima.');
            if(users[targetId].reportCount >= 3) {
                bannedIPs.add(users[targetId].ipHash);
                io.sockets.sockets.get(targetId)?.disconnect(true);
            }
        }
    });

    // Fitur Typing
    socket.on('typing', () => {
        const user = users[socket.id];
        if (user.mode === 'random' && user.partner) io.to(user.partner).emit('partner_typing');
        else if (user.mode === 'room' && user.room) socket.to(user.room).emit('partner_typing');
    });

    socket.on('stop_typing', () => {
        const user = users[socket.id];
        if (user.mode === 'random' && user.partner) io.to(user.partner).emit('partner_stop_typing');
        else if (user.mode === 'room' && user.room) socket.to(user.room).emit('partner_stop_typing');
    });

    socket.on('reveal_identity', () => {
        const user = users[socket.id];
        if (user.mode === 'random' && user.partner) {
            io.to(user.partner).emit('partner_revealed', { nickname: user.nickname });
        }
    });

    socket.on('disconnect', () => {
        leaveCurrentState(socket);
        delete users[socket.id];
        io.emit('update_user_count', io.engine.clientsCount);
    });
});

function leaveCurrentState(socket) {
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
