const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e6
});

app.get('/', (req, res) => res.send("AnonChat P2P Server Running"));

// --- DATABASE SEMENTARA (Memory) ---
let queue = {}; // Antrian Random Match
let rooms = {}; // Room Storage { roomId: [socketId1, socketId2] }
let users = {}; // User Info { socketId: { nickname, partner, roomId, ... } }
let bannedIPs = new Set();

function getIpHash(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return crypto.createHash('sha256').update(ip).digest('hex');
}

io.on('connection', (socket) => {
    const userIpHash = getIpHash(socket);
    if (bannedIPs.has(userIpHash)) {
        socket.emit('system_message', '🚫 Banned.');
        socket.disconnect(true);
        return;
    }

    io.emit('update_user_count', io.engine.clientsCount);

    // --- 1. RANDOM MATCHMAKING ---
    socket.on('find_match', ({ nickname, country, interests }) => {
        const interestList = typeof interests === 'string' ? interests.split(',').map(i=>i.trim().toLowerCase()) : [];
        
        users[socket.id] = { 
            nickname, country, interests: interestList, 
            partner: null, mode: 'random', ipHash: userIpHash 
        };

        if (!queue[country]) queue[country] = [];
        
        // Logika sederhana: ambil yang pertama antri
        if (queue[country].length > 0) {
            const partnerId = queue[country].shift();
            if (users[partnerId]) {
                // Match Found!
                users[socket.id].partner = partnerId;
                users[partnerId].partner = socket.id;

                // Beritahu kedua user untuk memulai koneksi (bisa Socket atau WebRTC)
                io.to(socket.id).emit('chat_start', { role: 'initiator', mode: 'random' });
                io.to(partnerId).emit('chat_start', { role: 'receiver', mode: 'random' });
            } else {
                queue[country].push(socket.id); // Partner hantu, antri ulang
            }
        } else {
            queue[country].push(socket.id);
            socket.emit('waiting', `Mencari partner di ${country}...`);
        }
    });

    // --- 2. ROOM LOGIC (P2P SETUP) ---
    socket.on('create_room', ({ nickname, roomId }) => {
        if (rooms[roomId]) return socket.emit('room_error', 'Room ID sudah dipakai!');
        
        users[socket.id] = { nickname, partner: null, mode: 'room', roomId, ipHash: userIpHash };
        rooms[roomId] = [socket.id];
        socket.join(roomId);
        socket.emit('waiting', `Room ${roomId} dibuat. Menunggu teman...`);
    });

    socket.on('join_room', ({ nickname, roomId }) => {
        const room = rooms[roomId];
        if (!room || room.length === 0) return socket.emit('room_error', 'Room tidak ditemukan.');
        if (room.length >= 2) return socket.emit('room_error', 'Room penuh!');

        const hostId = room[0];
        users[socket.id] = { nickname, partner: hostId, mode: 'room', roomId, ipHash: userIpHash };
        users[hostId].partner = socket.id;
        
        room.push(socket.id);
        socket.join(roomId);

        // Trigger P2P Handshake
        io.to(hostId).emit('chat_start', { role: 'initiator', mode: 'room' });
        io.to(socket.id).emit('chat_start', { role: 'receiver', mode: 'room' });
    });

    // --- 3. SIGNALING (WebRTC Relay) ---
    // Server hanya mengoper data signal (Offer/Answer/Candidate) tanpa membacanya
    socket.on('signal', (data) => {
        const user = users[socket.id];
        if (user && user.partner) {
            io.to(user.partner).emit('signal', data);
        }
    });

    // --- 4. FALLBACK MESSAGING (Jika WebRTC gagal) ---
    socket.on('send_message', (msg) => {
        const user = users[socket.id];
        if (user && user.partner) {
            io.to(user.partner).emit('receive_message', { msg, sender: 'Stranger', type: 'text' });
            socket.emit('receive_message', { msg, sender: 'You', isSelf: true, type: 'text' });
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            if (user.mode === 'random' && queue[user.country]) {
                queue[user.country] = queue[user.country].filter(id => id !== socket.id);
            }
            if (user.mode === 'room' && user.roomId && rooms[user.roomId]) {
                rooms[user.roomId] = rooms[user.roomId].filter(id => id !== socket.id);
                if (rooms[user.roomId].length === 0) delete rooms[user.roomId];
            }
            if (user.partner) {
                io.to(user.partner).emit('partner_left');
                if(users[user.partner]) users[user.partner].partner = null;
            }
            delete users[socket.id];
        }
        io.emit('update_user_count', io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
