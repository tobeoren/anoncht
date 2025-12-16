const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto'); // Library untuk Hash IP

const app = express();
const server = http.createServer(app);

// Konfigurasi CORS agar bisa diakses dari Netlify
const io = new Server(server, {
    cors: {
        origin: "*", // Mengizinkan akses dari mana saja (Netlify)
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e6 // Max 1 MB
});

app.get('/', (req, res) => {
    res.send("Server AnonChat berjalan! Silakan buka Frontend di Netlify.");
});

// --- KONFIGURASI ---
const RATE_LIMIT_MS = 500;
const BAD_WORDS = ["kasar", "bodoh", "anjing", "stupid"];

// --- DATABASE SEMENTARA (MEMORY) ---
let queue = {}; 
let users = {}; 
let bannedIPs = new Set(); // Daftar IP yang di-banned (Hash)

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

// Fungsi Hash IP (Mengubah IP jadi kode acak agar privasi terjaga)
function getIpHash(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return crypto.createHash('sha256').update(ip).digest('hex');
}

io.on('connection', (socket) => {
    // 1. CEK STATUS BANNED (IP Hashing System)
    const userIpHash = getIpHash(socket);
    if (bannedIPs.has(userIpHash)) {
        socket.emit('system_message', '🚫 Perangkat Anda telah diblokir permanen dari server.');
        socket.disconnect(true);
        return;
    }

    // 2. Update Counter
    io.emit('update_user_count', io.engine.clientsCount);

    // 3. User Mencari Teman
    socket.on('find_match', ({ nickname, country, interests }) => {
        // Parse minat
        const interestList = typeof interests === 'string' ? interests.split(',').map(i => i.trim().toLowerCase()).filter(i => i) : [];

        users[socket.id] = { 
            nickname: escapeHtml(nickname), 
            country: country, 
            interests: interestList,
            partner: null,
            revealed: false,
            lastMessageTime: 0,
            reportCount: 0, // Untuk sistem ban otomatis
            ipHash: userIpHash
        };

        findPartner(socket.id, country, interestList);
    });

    function findPartner(socketId, country, myInterests) {
        if (!queue[country]) queue[country] = [];
        
        let matchIndex = -1;

        // Prioritas: Minat Sama
        if (myInterests.length > 0) {
            matchIndex = queue[country].findIndex(waitingId => {
                const waiter = users[waitingId];
                if (!waiter) return false;
                const common = waiter.interests.filter(x => myInterests.includes(x));
                return common.length > 0;
            });
        }

        // Fallback: Siapa saja
        if (matchIndex === -1 && queue[country].length > 0) {
            matchIndex = 0;
        }

        if (matchIndex > -1) {
            const partnerId = queue[country].splice(matchIndex, 1)[0];
            
            if (users[partnerId]) {
                users[socketId].partner = partnerId;
                users[partnerId].partner = socketId;

                const partnerInterests = users[partnerId].interests;
                const commonTags = partnerInterests.filter(x => myInterests.includes(x));

                io.to(socketId).emit('chat_start', { role: 'initiator', commonTags });
                io.to(partnerId).emit('chat_start', { role: 'receiver', commonTags });
            } else {
                findPartner(socketId, country, myInterests);
            }
        } else {
            queue[country].push(socketId);
            socket.emit('waiting', `Mencari teman di ${country}...`);
        }
    }

    // 4. Relay Pesan
    socket.on('send_message', (msg) => {
        const user = users[socket.id];
        if (!user || !user.partner) return;

        // Rate Limit
        const now = Date.now();
        if (now - user.lastMessageTime < RATE_LIMIT_MS) return; 
        user.lastMessageTime = now;

        // Filter kata kasar (Hanya jika pesan BUKAN enkripsi E2EE)
        let safeMsg = msg;
        if (!msg.startsWith("ENC:")) {
            safeMsg = filterBadWords(escapeHtml(msg));
        }

        io.to(user.partner).emit('receive_message', { msg: safeMsg, sender: user.revealed ? user.nickname : 'Stranger', type: 'text' });
        socket.emit('receive_message', { msg: safeMsg, sender: 'You', isSelf: true, type: 'text' });
    });

    // 5. Relay Gambar
    socket.on('send_image', (imgData) => {
        const user = users[socket.id];
        if (user && user.partner) {
            io.to(user.partner).emit('receive_message', { msg: imgData, sender: user.revealed ? user.nickname : 'Stranger', type: 'image' });
            socket.emit('receive_message', { msg: imgData, sender: 'You', isSelf: true, type: 'image' });
        }
    });

    // 6. FITUR BARU: Signal Key Exchange (Untuk E2EE)
    socket.on('signal_key', (keyData) => {
        const user = users[socket.id];
        if (user && user.partner) {
            // Teruskan Kunci Publik ke partner tanpa menyimpannya
            io.to(user.partner).emit('signal_key', keyData);
        }
    });

    // 7. Sistem Report & Auto Ban
    socket.on('rate_partner', ({ action }) => {
        const user = users[socket.id];
        if (!user || !user.partner) return;
        
        const partnerSocketId = user.partner;
        const partner = users[partnerSocketId];
        
        if (action === 'report') {
            partner.reportCount += 1;
            socket.emit('system_message', '🚩 Laporan diterima.');
            
            // LOGIKA BAN: Jika dilaporkan 3 kali dalam satu sesi
            if (partner.reportCount >= 3) {
                bannedIPs.add(partner.ipHash); // Masukkan Hash IP ke daftar hitam
                io.to(partnerSocketId).emit('system_message', '🚫 Anda telah di-banned karena perilaku buruk.');
                io.sockets.sockets.get(partnerSocketId)?.disconnect(true); // Tendang user
            }
        } else if (action === 'like') {
            io.to(partnerSocketId).emit('system_message', '👍 Partner memberikan jempol!');
        }
    });

    // 8. Fitur Lain
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
            socket.emit('system_message', '🔓 Identitas terungkap.');
        }
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket.id);
        io.emit('update_user_count', io.engine.clientsCount);
    });
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

// Gunakan port dari environment variable (penting untuk Glitch/Render)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
