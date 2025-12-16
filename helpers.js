const fs = require('fs');
const crypto = require('crypto');

// --- LOAD BAD WORDS ---
let BAD_WORDS = [];
try {
    const data = fs.readFileSync('wordlist.json', 'utf8');
    BAD_WORDS = JSON.parse(data);
    console.log(`✅ Loaded ${BAD_WORDS.length} bad words.`);
} catch (err) {
    console.warn("⚠️ Gagal memuat wordlist.json, menggunakan daftar default.");
    BAD_WORDS = ["kasar", "bodoh", "anjing"];
}

// --- ALIAS GENERATOR DATA ---
const ADJECTIVES = ["Neon", "Cyber", "Dark", "Holy", "Red", "Blue", "Fast", "Slow", "Quiet", "Loud", "Mystic", "Iron", "Shadow"];
const NOUNS = ["Fox", "Tiger", "Eagle", "Ghost", "Shadow", "Wolf", "Bear", "Shark", "Dragon", "Owl", "Raven", "Snake", "Viper"];

module.exports = {
    // 1. Generate Room Alias (Nama Samaran Unik)
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

    // 4. Hash IP (Privasi)
    getIpHash: (socket) => {
        const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        return crypto.createHash('sha256').update(ip).digest('hex');
    }
};
