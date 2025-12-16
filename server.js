const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto'); // Library untuk Hash IP

const app = express();
const server = http.createServer(app);

// Konfigurasi CORS & Buffer Size
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 5e6 // Max 5 MB
});

app.get('/', (req, res) => res.send("AnonChat P2P Server Running (Complete Ver)"));

// --- KONFIGURASI KEAMANAN ---
const RATE_LIMIT_MS = 500; // Batas kecepatan chat (Anti-spam)
const BAD_WORDS = ["kasar", "bodoh", "anjing", "stupid", "tolol", "bangsat"]; // Tambahkan kata lain di sini

// --- DATABASE SEMENTARA (MEMORY) ---
let queue = {};     // Antrian Random Match: { 'Indonesia': [socketId1, ...] }
let rooms = {};     // Room Storage: { 'roomId': [socketId1, socketId2] }
let users = {};     // User Info: { socketId: { nickname, partner, roomId, mode, deviceId, ... } }
let bannedIPs = new Set(); // Blacklist IP (Layer 1)
let bannedDevices = new Set(); // Blacklist Device ID (Layer 2)

// --- FUNGSI BANTUAN ---

// 1. Sanitasi HTML (Mencegah XSS)
function escapeHtml(text) {
    if (!text) return text;
    return text.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
}

// 2. Sensor Kata Kasar
function filterBadWords(text) {
    let cleanText = text;
    BAD_WORDS.forEach(word => {
        const regex = new RegExp(`\\b${word}\\b`, "gi");
        cleanText = cleanText.replace(regex, "***");
    });
    return cleanText;
}

// 3. Hash IP (Privasi)
function getIpHash(socket) {
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    return crypto.createHash('sha256').update(ip).digest('hex');
}

io.on('connection', (socket) => {
    // A. CEK STATUS BANNED (Layer 1: IP Check saat koneksi awal)
    const userIpHash = getIpHash(socket);
    if (bannedIPs.has(userIpHash)) {
        socket.emit('system_message', '🚫 Akses Ditolak: IP Anda telah diblokir.');
        socket.disconnect(true);
        return;
    }

    io.emit('update_user_count', io.engine.clientsCount);

    // --- MIDDLEWARE CEK DEVICE ID (Layer 2: Device Check saat aksi) ---
    // Fungsi ini dipanggil setiap kali user ingin melakukan aksi (find match/create room)
    const checkDeviceBan = (deviceId) => {
        if (deviceId && bannedDevices.has(deviceId)) {
            socket.emit('system_message', '🚫 Akses Ditolak: Perangkat Anda telah diblokir permanen.');
            socket.disconnect(true);
            return true; // Terblokir
        }
        return false; // Aman
    };

    // B. LOGIKA MATCHMAKING

    // 1. Random Match (dengan Device ID)
    socket.on('find_match', ({ nickname, country, interests, deviceId }) => {
        if(checkDeviceBan(deviceId)) return;

        // Parse minat
        const interestList = typeof interests === 'string' ? interests.split(',').map(i => i.trim().toLowerCase()).filter(i => i) : [];

        users[socket.id] = { 
            nickname: escapeHtml(nickname), 
            country, 
            interests: interestList,
            partner: null, 
            mode: 'random',
            lastMessageTime: 0,
            reportCount: 0,
            revealed: false,
            ipHash: userIpHash,
            deviceId: deviceId // Simpan Device ID untuk keperluan ban nanti
        };
        
        if (!queue[country]) queue[country] = [];
        
        // Cek apakah ada yang antri
        if (queue[country].length > 0) {
            // Logika Antrian Sederhana: Ambil yang terdepan
            // (Bisa dikembangkan dengan mencocokkan interests di sini)
            const partnerId = queue[country].shift();
            
            if(users[partnerId]) {
                // Match Found!
                users[socket.id].partner = partnerId;
                users[partnerId].partner = socket.id;

                // Hitung kesamaan interest (opsional, untuk info ke user)
                const partnerInterests = users[partnerId].interests;
                const commonTags = partnerInterests.filter(x => interestList.includes(x));

                io.to(socket.id).emit('chat_start', { role: 'initiator', mode: 'random', commonTags });
                io.to(partnerId).emit('chat_start', { role: 'receiver', mode: 'random', commonTags });
            } else {
                // Jika partner hantu (disconnect saat antri), cari lagi
                queue[country].push(socket.id);
                socket.emit('waiting', `Mencari partner di ${country}...`);
            }
        } else {
            queue[country].push(socket.id);
            socket.emit('waiting', `Mencari partner di ${country}...`);
        }
    });

    // 2. Private Room Logic
    socket.on('create_room', ({ nickname, roomId, deviceId }) => {
        if(checkDeviceBan(deviceId)) return;

        if (rooms[roomId]) return socket.emit('waiting', '❌ Room ID sudah terpakai!');
        
        users[socket.id] = { 
            nickname: escapeHtml(nickname), 
            partner: null, 
            mode: 'room', 
            roomId, 
            lastMessageTime: 0,
            reportCount: 0,
            revealed: false,
            ipHash: userIpHash,
            deviceId: deviceId
        };
        
        rooms[roomId] = [socket.id];
        socket.join(roomId);
        socket.emit('waiting', `✅ Room ${roomId} dibuat. Menunggu teman...`);
    });

    socket.on('join_room', ({ nickname, roomId, deviceId }) => {
        if(checkDeviceBan(deviceId)) return;

        const room = rooms[roomId];
        if (!room || room.length === 0) return socket.emit('waiting', '❌ Room tidak ditemukan.');
        if (room.length >= 2) return socket.emit('waiting', '❌ Room penuh!');

        const hostId = room[0];
        
        users[socket.id] = { 
            nickname: escapeHtml(nickname), 
            partner: hostId, 
            mode: 'room', 
            roomId, 
            lastMessageTime: 0,
            reportCount: 0,
            revealed: false,
            ipHash: userIpHash,
            deviceId: deviceId
        };
        
        users[hostId].partner = socket.id;
        
        room.push(socket.id);
        socket.join(roomId);
        
        io.to(hostId).emit('chat_start', { role: 'initiator', mode: 'room' });
        io.to(socket.id).emit('chat_start', { role: 'receiver', mode: 'room' });
    });

    // C. FITUR UTAMA (Relay & Signal)

    // 1. WebRTC Signaling (Jembatan P2P)
    socket.on('signal', (data) => {
        const user = users[socket.id];
        if (user && user.partner) {
            io.to(user.partner).emit('signal', data);
        }
    });

    // 2. Relay Message (Fallback jika P2P Gagal + MODERASI)
    socket.on('send_message', (payloadStr) => {
        const user = users[socket.id];
        if (!user || !user.partner) return;

        // Rate Limit Check
        const now = Date.now();
        if (now - user.lastMessageTime < RATE_LIMIT_MS) return;
        user.lastMessageTime = now;

        try {
            // Parsing JSON payload dari client
            let payload = JSON.parse(payloadStr);

            // MODERASI (Hanya jika tipe text)
            if (payload.type === 'text') {
                // Escape HTML & Filter Bad Words
                let safeContent = escapeHtml(payload.content);
                // Jangan filter jika pesan terenkripsi (opsional, tergantung implementasi e2ee)
                if (!payload.content.startsWith("ENC:")) {
                    safeContent = filterBadWords(safeContent);
                }
                
                payload.content = safeContent;
                
                // Update nama sender jika reveal aktif (Server-side check)
                payload.sender = user.revealed ? user.nickname : 'Stranger';
            }

            // Kemas ulang dan kirim ke partner
            io.to(user.partner).emit('receive_message', JSON.stringify(payload));

        } catch (e) {
            console.error("Error parsing message relay:", e);
        }
    });

    // D. FITUR SOSIAL (Typing, Reveal, Report)

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
            // Kirim notifikasi sistem ke kedua belah pihak
            const sysMsg = JSON.stringify({
                isSystem: true,
                content: `🔓 Identitas Terungkap: ${user.nickname}`
            });
            io.to(user.partner).emit('receive_message', sysMsg);
            socket.emit('receive_message', sysMsg);
            
            // Event khusus untuk update UI (opsional, tergantung frontend)
            io.to(user.partner).emit('partner_revealed', { nickname: user.nickname });
        }
    });

    // Sistem Report & Auto Ban (Dengan Device ID)
    socket.on('rate_partner', ({ action }) => {
        const user = users[socket.id];
        if (!user || !user.partner) return;
        
        const partnerSocketId = user.partner;
        const partner = users[partnerSocketId];
        
        if (action === 'report') {
            partner.reportCount += 1;
            socket.emit('system_message', '🚩 Laporan diterima. Terima kasih.');
            
            // Ban jika dilaporkan 3 kali dalam sesi ini
            if (partner.reportCount >= 3) {
                // Ban IP (Layer 1)
                bannedIPs.add(partner.ipHash);
                
                // Ban Device ID (Layer 2) - Lebih spesifik
                if (partner.deviceId) {
                    bannedDevices.add(partner.deviceId);
                }

                io.to(partnerSocketId).emit('system_message', '🚫 Anda diblokir karena laporan berulang dari pengguna lain.');
                io.sockets.sockets.get(partnerSocketId)?.disconnect(true);
            }
        }
        // Fitur Like dihapus sesuai request, tapi handler bisa dibiarkan kosong atau dihapus
    });

    // E. DISCONNECT HANDLING
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            // Bersihkan antrian Random
            if (user.mode === 'random' && queue[user.country]) {
                queue[user.country] = queue[user.country].filter(id => id !== socket.id);
            }
            // Bersihkan Room
            if (user.mode === 'room' && user.roomId && rooms[user.roomId]) {
                rooms[user.roomId] = rooms[user.roomId].filter(id => id !== socket.id);
                if(rooms[user.roomId].length === 0) delete rooms[user.roomId];
            }
            // Beritahu Partner
            if (user.partner && users[user.partner]) {
                io.to(user.partner).emit('partner_left');
                users[user.partner].partner = null;
            }
            delete users[socket.id];
        }
        io.emit('update_user_count', io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Complete running on port ${PORT}`));
