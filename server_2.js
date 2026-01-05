const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

const PORT = process.env.PORT || 10000;
const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;
const SERVER_3_URL = process.env.SERVER_3_URL;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// ==================== إعدادات الحماية الأصلية ====================
const ADVANCED_PROXIES = [
    { url: '', name: 'Direct' },
    { url: 'https://cors-anywhere.herokuapp.com/', name: 'Cors Anywhere' },
    { url: 'https://api.allorigins.win/raw?url=', name: 'All Origins' },
    { url: 'https://corsproxy.io/?', name: 'Cors Proxy' }
];

function getAdvancedHeaders() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    ];
    return {
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://azoramoon.com/'
    };
}

async function fetchPageWithRetry(url, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const proxy = ADVANCED_PROXIES[Math.floor(Math.random() * ADVANCED_PROXIES.length)];
        try {
            let targetUrl = proxy.url ? proxy.url + encodeURIComponent(url) : url;
            const response = await axios.get(targetUrl, {
                headers: getAdvancedHeaders(),
                timeout: 20000
            });
            if (response.status === 200) return response.data;
        } catch (error) {}
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('فشل الجلب');
}

// ==================== دوال Firebase ====================
async function writeToFirebase(path, data) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    await axios.put(url, data);
}

async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (e) { return null; }
}

// ==================== منطق الفصول ====================
async function notifyServer3(mangaId, chapterId) {
    if (!SERVER_3_URL) return;
    try { await axios.get(`${SERVER_3_URL}/process-chapter/${mangaId}/${chapterId}`, { timeout: 5000 }); } catch (e) {}
}

async function processMangaJob(mangaId, job) {
    console.log(`📖 معالجة فصول: ${job.title}`);
    try {
        const html = await fetchPageWithRetry(job.mangaUrl);
        const $ = cheerio.load(html);
        const chapters = [];
        $('.wp-manga-chapter, .chapter-item, .listing-chapters_wrap a').each((i, el) => {
            const link = $(el).attr('href') || $(el).find('a').attr('href');
            const title = $(el).text().trim() || $(el).find('a').text().trim();
            if (link && link.includes('chapter')) {
                const chapterId = crypto.createHash('md5').update(link).digest('hex').substring(0, 12);
                chapters.push({ chapterId, title, url: link, status: 'pending_images' });
            }
        });

        const existingChapters = await readFromFirebase(`ImgChapter/${mangaId}`) || {};
        for (const ch of chapters) {
            if (!existingChapters[ch.chapterId]) {
                await writeToFirebase(`ImgChapter/${mangaId}/${ch.chapterId}`, ch);
                await notifyServer3(mangaId, ch.chapterId);
            }
        }
        await writeToFirebase(`Jobs/${mangaId}`, { ...job, status: 'completed', lastCheck: Date.now() });
    } catch (e) { console.error(e.message); }
}

const app = express();
app.get('/process-manga/:mangaId', async (req, res) => {
    const job = await readFromFirebase(`Jobs/${req.params.mangaId}`);
    if (job) processMangaJob(req.params.mangaId, job);
    res.json({ success: true });
});
app.get('/start-continuous-check', async (req, res) => {
    const allJobs = await readFromFirebase('Jobs');
    if (allJobs) {
        for (const [id, job] of Object.entries(allJobs)) {
            if (job.status === 'waiting_chapters') {
                await processMangaJob(id, job);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    res.json({ success: true });
});
app.listen(PORT, () => {
    setInterval(async () => { try { await axios.get(`http://localhost:${PORT}/start-continuous-check`); } catch(e){} }, 1000 * 60 * 10);
});
