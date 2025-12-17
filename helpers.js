const fs = require('fs');
const crypto = require('crypto');

// --- LOAD BAD WORDS DARI FILE JSON ---
let BAD_WORDS = [];
try {
    const data = fs.readFileSync('wordlist.json', 'utf8');
    BAD_WORDS = JSON.parse(data);
    console.log(`✅ Loaded ${BAD_WORDS.length} bad words from wordlist.json`);
} catch (err) {
    console.warn("⚠️ Gagal memuat wordlist.json, menggunakan daftar default.");
    BAD_WORDS = ["kasar", "bodoh", "anjing", "stupid"];
}

// --- ALIAS GENERATOR DATA ---
const ADJECTIVES = ["Neon", "Cyber", "Dark", "Holy", "Red", "Blue", "Fast", "Slow", "Quiet", "Loud", "Mystic", "Iron", "Shadow", "Golden", "Silver"];
const NOUNS = ["Fox", "Tiger", "Eagle", "Ghost", "Shadow", "Wolf", "Bear", "Shark", "Dragon", "Owl", "Raven", "Snake", "Viper", "Lion", "Panther"];

module.exports = {
    // 1. Generate Room Alias (Nama Samaran Unik di Room)
    generateRoomAlias: () => {
        const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
        const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
        const num = Math.floor(Math.random() * 999);
        return `${adj}${noun}#${num}`;
    },

    // 2. Sanitasi HTML (Mencegah XSS)
    escapeHtml: (text) => {
        if (!text) return text;
        return text.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m]);
    },

    // 3. Sensor Kata Kasar
    filterBadWords: (text) => {
        if (!text) return "";
        let cleanText = text;
        BAD_WORDS.forEach(word => {
            // Regex: \b = batas kata, gi = global case-insensitive
            const regex = new RegExp(`\\b${word}\\b`, "gi");
            cleanText = cleanText.replace(regex, "***");
        });
        return cleanText;
    },

    // 4. Hash Subnet IP (Level 3: Anti-Dynamic IP)
    getIpHash: (socket) => {
        // Ambil IP Asli
        let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        
        // Bersihkan format IPv6 mapping (::ffff:192.168.1.1)
        if (ip.substr(0, 7) == "::ffff:") {
            ip = ip.substr(7);
        }

        let subnet = ip;

        // Logika Subnetting (IPv4)
        // Kita ambil 3 segmen pertama (Class C). Contoh: 192.168.1.15 -> 192.168.1.0
        if (ip.includes('.')) {
            const parts = ip.split('.');
            if(parts.length === 4) {
                subnet = `${parts[0]}.${parts[1]}.${parts[2]}.0`; 
            }
        } 
        // Logika Subnetting (IPv6)
        // Kita ambil prefix yang umum (biasanya /64)
        else if (ip.includes(':')) {
            const parts = ip.split(':');
            if(parts.length > 4) {
                subnet = parts.slice(0, 4).join(':') + "::"; 
            }
        }

        // Hash subnet tersebut
        return crypto.createHash('sha256').update(subnet).digest('hex');
    }
};
