const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

const PORT = process.env.PORT || 10000;
const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;
const SERVER_3_URL = process.env.SERVER_3_URL;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

const ADVANCED_PROXIES = [
    { url: '', name: 'Direct' },
    { url: 'https://corsproxy.io/?', name: 'Cors Proxy' },
    { url: 'https://api.allorigins.win/raw?url=', name: 'All Origins' }
];

function getAdvancedHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://azoramoon.com/'
    };
}

async function fetchPageWithRetry(url, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const proxy = ADVANCED_PROXIES[Math.floor(Math.random() * ADVANCED_PROXIES.length)];
        try {
            let targetUrl = proxy.url ? proxy.url + encodeURIComponent(url) : url;
            const response = await axios.get(targetUrl, {
                headers: getAdvancedHeaders(),
                timeout: 30000
            });
            if (response.status === 200) return response.data;
        } catch (error) {}
        await new Promise(r => setTimeout(r, 3000 * attempt));
    }
    throw new Error('فشل الجلب');
}

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

async function uploadToImgBB(imageUrl) {
    if (!IMGBB_API_KEY) return null;
    try {
        const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', headers: getAdvancedHeaders(), timeout: 20000 });
        const base64 = Buffer.from(imgRes.data, 'binary').toString('base64');
        const formData = new URLSearchParams();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', base64);
        const res = await axios.post('https://api.imgbb.com/1/upload', formData);
        return res.data.success ? res.data.data.url : null;
    } catch (e) { return null; }
}

async function notifyServer3(mangaId, chapterId) {
    if (!SERVER_3_URL) return;
    try { 
        const target = SERVER_3_URL.startsWith('http') ? SERVER_3_URL : `https://${SERVER_3_URL}`;
        await axios.get(`${target}/process-chapter/${mangaId}/${chapterId}`, { timeout: 5000 }); 
    } catch (e) {}
}

async function processMangaJob(mangaId, job) {
    console.log(`📖 معالجة: ${job.title}`);
    try {
        const html = await fetchPageWithRetry(job.mangaUrl);
        const $ = cheerio.load(html);
        
        // 1. استخراج ورفع صورة المانجا (Thumbnail)
        const thumbUrl = $('.summary_image img').attr('src') || $('.post-thumbnail img').attr('src');
        if (thumbUrl) {
            const uploadedThumb = await uploadToImgBB(thumbUrl);
            if (uploadedThumb) {
                await writeToFirebase(`HomeManga/${mangaId}/thumbnail`, uploadedThumb);
            }
        }

        // 2. استخراج الفصول
        const chapters = [];
        $('.wp-manga-chapter a, .chapter-item a, .listing-chapters_wrap a').each((i, el) => {
            const link = $(el).attr('href');
            const title = $(el).text().trim();
            if (link && (link.includes('/chapter-') || link.includes('/chapter/'))) {
                const chapterId = crypto.createHash('md5').update(link).digest('hex').substring(0, 12);
                chapters.push({ chapterId, title, url: link, status: 'pending_images' });
            }
        });

        if (chapters.length > 0) {
            const existingChapters = await readFromFirebase(`ImgChapter/${mangaId}`) || {};
            for (const ch of chapters) {
                if (!existingChapters[ch.chapterId]) {
                    await writeToFirebase(`ImgChapter/${mangaId}/${ch.chapterId}`, ch);
                    await notifyServer3(mangaId, ch.chapterId);
                }
            }
            await writeToFirebase(`Jobs/${mangaId}`, { ...job, status: 'completed', pending: false, lastCheck: Date.now() });
            console.log(`✅ تم العثور على ${chapters.length} فصل لـ ${job.title}`);
        } else {
            console.log(`❌ لم يتم العثور على فصول لـ ${job.title}`);
        }
    } catch (e) {
        console.error(`❌ خطأ في ${job.title}: ${e.message}`);
    }
}

const app = express();
app.get('/process-manga/:mangaId', async (req, res) => {
    const mangaId = req.params.mangaId;
    const job = await readFromFirebase(`Jobs/${mangaId}`);
    if (job) {
        processMangaJob(mangaId, job);
        res.json({ success: true, message: 'Started' });
    } else {
        res.status(404).json({ success: false });
    }
});

app.get('/start-continuous-check', async (req, res) => {
    const allJobs = await readFromFirebase('Jobs');
    if (allJobs) {
        for (const [id, job] of Object.entries(allJobs)) {
            if (job.status === 'waiting_chapters' || job.pending === true) {
                await processMangaJob(id, job);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
    res.json({ success: true });
});

app.get('/', (req, res) => { res.send('<h1>⚙️ السيرفر الثاني - V3 Fixed V2</h1>'); });

app.listen(PORT, () => {
    console.log(`Server 2 running on ${PORT}`);
    setInterval(async () => { try { await axios.get(`http://localhost:${PORT}/start-continuous-check`); } catch(e){} }, 1000 * 60 * 10);
});
