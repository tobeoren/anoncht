const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// Set max payload besar agar bisa kirim gambar
const io = new Server(server, {
    maxHttpBufferSize: 1e6 // Max 1 MB per pesan/gambar
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- KONFIGURASI ---
const RATE_LIMIT_MS = 500;
const BAD_WORDS = ["kasar", "bodoh", "anjing", "stupid"];

// --- FUNGSI BANTUAN ---
function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}

function filterBadWords(text) {
    let cleanText = text;
    BAD_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, "gi");
        cleanText = cleanText.replace(regex, "***");
    });
    return cleanText;
}

// --- DATA STORE ---
let queue = {}; // { 'Indonesia': [socket_id, ...], ... }
let users = {}; // Data user lengkap

io.on('connection', (socket) => {
    // 1. Update Online Counter
    io.emit('update_user_count', io.engine.clientsCount);

    socket.on('find_match', ({ nickname, country, interests }) => {
        // Parse interests jadi array lowercase
        const interestList = interests.split(',').map(i => i.trim().toLowerCase()).filter(i => i);

        users[socket.id] = { 
            nickname: escapeHtml(nickname), 
            country: country, 
            interests: interestList,
            partner: null,
            revealed: false,
            lastMessageTime: 0,
            karma: 100 // Modal awal reputasi
        };

        findPartner(socket.id, country, interestList);
    });

    // LOGIKA MATCHMAKING DENGAN MINAT
    function findPartner(socketId, country, myInterests) {
        if (!queue[country]) queue[country] = [];
        
        // Cari partner di antrean yang punya minat sama
        let matchIndex = -1;
        
        // Prioritas 1: Cari yang minatnya SAMA
        if (myInterests.length > 0) {
            matchIndex = queue[country].findIndex(waitingId => {
                const waiter = users[waitingId];
                if (!waiter) return false;
                // Cek irisan minat (Intersection)
                const common = waiter.interests.filter(x => myInterests.includes(x));
                return common.length > 0;
            });
        }

        // Prioritas 2: Jika tidak ada minat sama, ambil siapa saja (First Come First Serve)
        if (matchIndex === -1 && queue[country].length > 0) {
            matchIndex = 0;
        }

        if (matchIndex > -1) {
            // MATCH FOUND
            const partnerId = queue[country].splice(matchIndex, 1)[0];
            
            if (users[partnerId]) {
                users[socketId].partner = partnerId;
                users[partnerId].partner = socketId;

                // Cek kesamaan minat untuk notifikasi
                const partnerInterests = users[partnerId].interests;
                const commonTags = partnerInterests.filter(x => myInterests.includes(x));

                io.to(socketId).emit('chat_start', { role: 'initiator', commonTags });
                io.to(partnerId).emit('chat_start', { role: 'receiver', commonTags });
            } else {
                // Partner hantu, coba lagi
                findPartner(socketId, country, myInterests);
            }
        } else {
            // Tidak ada teman, masuk antrean
            queue[country].push(socketId);
            socket.emit('waiting', `Mencari teman di ${country}... (Tag: ${myInterests.join(', ') || 'Semua'})`);
        }
    }

    // 2. Kirim Pesan Biasa
    socket.on('send_message', (msg) => {
        const user = users[socket.id];
        if (!user || !user.partner) return;

        const now = Date.now();
        if (now - user.lastMessageTime < RATE_LIMIT_MS) return; // Rate limit
        user.lastMessageTime = now;

        let safeMsg = filterBadWords(escapeHtml(msg));

        io.to(user.partner).emit('receive_message', { msg: safeMsg, sender: user.revealed ? user.nickname : 'Stranger', type: 'text' });
        socket.emit('receive_message', { msg: safeMsg, sender: 'You', isSelf: true, type: 'text' });
    });

    // 3. Kirim Gambar (Base64)
    socket.on('send_image', (imgData) => {
        const user = users[socket.id];
        if (user && user.partner) {
            io.to(user.partner).emit('receive_message', { msg: imgData, sender: user.revealed ? user.nickname : 'Stranger', type: 'image' });
            socket.emit('receive_message', { msg: imgData, sender: 'You', isSelf: true, type: 'image' });
        }
    });

    // 4. Sistem Reputasi (Like & Report)
    socket.on('rate_partner', ({ action }) => {
        const user = users[socket.id];
        if (!user || !user.partner) return;
        
        const partner = users[user.partner];
        
        if (action === 'like') {
            partner.karma += 10;
            socket.emit('system_message', '👍 Kamu menyukai partner ini.');
            io.to(user.partner).emit('system_message', '👍 Partner memberikan jempol untukmu!');
        } else if (action === 'report') {
            partner.karma -= 50;
            socket.emit('system_message', '🚩 Laporan diterima. Sistem akan mencatat perilaku partner.');
            // Jika karma terlalu rendah, bisa ditendang (opsional)
            if (partner.karma < 0) {
                 io.to(user.partner).emit('system_message', '⚠️ Peringatan: Anda mendapat banyak laporan buruk.');
            }
        }
    });

    // 5. Fitur Standar (Typing, Reveal, Disconnect)
    socket.on('typing', () => {
        const user = users[socket.id];
        if (user && user.partner) io.to(user.partner).emit('partner_typing');
    });

    socket.on('stop_typing', () => {
        const user = users[socket.id];
        if (user && user.partner) io.to(user.partner).emit('partner_stop_typing');
    });

    socket.on('reveal_identity', () => {
        const user = users[socket.id];
        if (user && user.partner) {
            user.revealed = true;
            io.to(user.partner).emit('partner_revealed', { nickname: user.nickname });
            socket.emit('system_message', '🔓 Identitas kamu terungkap.');
        }
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket.id);
        io.emit('update_user_count', io.engine.clientsCount);
    });

    socket.on('leave_chat', () => handleDisconnect(socket.id));
});

function handleDisconnect(socketId) {
    const user = users[socketId];
    if (user) {
        if (queue[user.country]) {
            queue[user.country] = queue[user.country].filter(id => id !== socketId);
        }
        if (user.partner && users[user.partner]) {
            io.to(user.partner).emit('partner_left');
            users[user.partner].partner = null;
        }
        delete users[socketId];
    }
}

server.listen(3000, () => {
    console.log('Server berjalan di http://localhost:3000');
});
