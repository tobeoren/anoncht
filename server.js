const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 5e6 // Naikkan jadi 5MB untuk gambar via relay
});

app.get('/', (req, res) => res.send("AnonChat P2P Server Running"));

let queue = {}; 
let rooms = {}; 
let users = {}; 
let bannedIPs = new Set();

function getIpHash(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return crypto.createHash('sha256').update(ip).digest('hex');
}

io.on('connection', (socket) => {
    const userIpHash = getIpHash(socket);
    if (bannedIPs.has(userIpHash)) {
        socket.disconnect(true);
        return;
    }

    io.emit('update_user_count', io.engine.clientsCount);

    socket.on('find_match', ({ nickname, country }) => {
        users[socket.id] = { nickname, country, partner: null, mode: 'random' };
        
        if (!queue[country]) queue[country] = [];
        if (queue[country].length > 0) {
            const partnerId = queue[country].shift();
            // Start Chat
            users[socket.id].partner = partnerId;
            users[partnerId].partner = socket.id;
            io.to(socket.id).emit('chat_start', { role: 'initiator' });
            io.to(partnerId).emit('chat_start', { role: 'receiver' });
        } else {
            queue[country].push(socket.id);
            socket.emit('waiting', `Menunggu partner di ${country}...`);
        }
    });

    socket.on('create_room', ({ nickname, roomId }) => {
        if (rooms[roomId]) return socket.emit('waiting', 'Room ID terpakai!');
        users[socket.id] = { nickname, partner: null, mode: 'room', roomId };
        rooms[roomId] = [socket.id];
        socket.join(roomId);
        socket.emit('waiting', `Room ${roomId} dibuat. Menunggu teman...`);
    });

    socket.on('join_room', ({ nickname, roomId }) => {
        const room = rooms[roomId];
        if (!room || room.length === 0) return socket.emit('waiting', 'Room tidak ditemukan.');
        const hostId = room[0];
        
        users[socket.id] = { nickname, partner: hostId, mode: 'room', roomId };
        users[hostId].partner = socket.id;
        
        room.push(socket.id);
        socket.join(roomId);
        
        io.to(hostId).emit('chat_start', { role: 'initiator' });
        io.to(socket.id).emit('chat_start', { role: 'receiver' });
    });

    // --- RELAY MESSAGES (FALLBACK) ---
    // Penting: Server hanya mengoper pesan jika P2P gagal
    socket.on('send_message', (payloadStr) => {
        const user = users[socket.id];
        if (user && user.partner) {
            io.to(user.partner).emit('receive_message', payloadStr);
        }
    });

    // --- WEBRTC SIGNALING ---
    socket.on('signal', (data) => {
        const user = users[socket.id];
        if (user && user.partner) {
            io.to(user.partner).emit('signal', data);
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            if (user.mode === 'random' && queue[user.country]) {
                queue[user.country] = queue[user.country].filter(id => id !== socket.id);
            }
            if (user.mode === 'room' && rooms[user.roomId]) {
                delete rooms[user.roomId];
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
