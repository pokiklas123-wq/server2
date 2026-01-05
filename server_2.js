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

// ==================== إعدادات الحماية المحسنة ====================
const ADVANCED_PROXIES = [
    { url: '', name: 'Direct' },
    { url: 'https://corsproxy.io/?', name: 'Cors Proxy' },
    { url: 'https://api.allorigins.win/raw?url=', name: 'All Origins' },
    { url: 'https://thingproxy.freeboard.io/fetch/', name: 'ThingProxy' }
];

function getAdvancedHeaders() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];
    return {
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        'Referer': 'https://azoramoon.com/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
}

async function fetchPageWithRetry(url, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const proxy = ADVANCED_PROXIES[Math.floor(Math.random() * ADVANCED_PROXIES.length)];
        try {
            let targetUrl = proxy.url ? proxy.url + encodeURIComponent(url) : url;
            console.log(`Attempt ${attempt} using ${proxy.name} for: ${url}`);
            const response = await axios.get(targetUrl, {
                headers: getAdvancedHeaders(),
                timeout: 30000,
                validateStatus: (status) => status === 200
            });
            if (response.data) return response.data;
        } catch (error) {
            console.log(`⚠️ Attempt ${attempt} failed: ${error.message}`);
        }
        await new Promise(r => setTimeout(r, 3000 * attempt));
    }
    throw new Error('فشل الجلب بعد عدة محاولات');
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
    try { 
        const target = SERVER_3_URL.startsWith('http') ? SERVER_3_URL : `https://${SERVER_3_URL}`;
        await axios.get(`${target}/process-chapter/${mangaId}/${chapterId}`, { timeout: 10000 }); 
    } catch (e) {
        console.log(`⚠️ فشل إخطار السيرفر الثالث للفصل ${chapterId}: ${e.message}`);
    }
}

async function processMangaJob(mangaId, job) {
    console.log(`📖 معالجة فصول: ${job.title}`);
    try {
        const html = await fetchPageWithRetry(job.mangaUrl);
        const $ = cheerio.load(html);
        const chapters = [];
        
        // تحسين محددات الفصول لتشمل المزيد من الاحتمالات
        $('.wp-manga-chapter a, .chapter-item a, .listing-chapters_wrap a').each((i, el) => {
            const link = $(el).attr('href');
            const title = $(el).text().trim();
            if (link && (link.includes('/chapter-') || link.includes('/chapter/'))) {
                const chapterId = crypto.createHash('md5').update(link).digest('hex').substring(0, 12);
                chapters.push({ chapterId, title, url: link, status: 'pending_images' });
            }
        });

        if (chapters.length === 0) {
            console.log(`❌ لم يتم العثور على فصول لـ: ${job.title}`);
            return;
        }

        console.log(`✅ تم العثور على ${chapters.length} فصل لـ: ${job.title}`);
        const existingChapters = await readFromFirebase(`ImgChapter/${mangaId}`) || {};
        
        for (const ch of chapters) {
            if (!existingChapters[ch.chapterId]) {
                await writeToFirebase(`ImgChapter/${mangaId}/${ch.chapterId}`, ch);
                await notifyServer3(mangaId, ch.chapterId);
                // تأخير بسيط لتجنب الضغط على السيرفر الثالث
                await new Promise(r => setTimeout(r, 500));
            }
        }
        
        // تحديث حالة الوظيفة وإزالة pending
        await writeToFirebase(`Jobs/${mangaId}`, { 
            ...job, 
            status: 'completed', 
            pending: false, 
            lastCheck: Date.now() 
        });
    } catch (e) { 
        console.error(`❌ خطأ في معالجة ${job.title}: ${e.message}`);
    }
}

const app = express();

// معالجة مانجا محددة
app.get('/process-manga/:mangaId', async (req, res) => {
    const mangaId = req.params.mangaId;
    const job = await readFromFirebase(`Jobs/${mangaId}`);
    if (job) {
        // تشغيل المعالجة في الخلفية وعدم انتظارها للرد بسرعة على السيرفر الأول
        processMangaJob(mangaId, job).catch(err => console.error(err));
        res.json({ success: true, message: 'Processing started' });
    } else {
        res.status(404).json({ success: false, message: 'Job not found' });
    }
});

// فحص مستمر للوظائف المنتظرة
app.get('/start-continuous-check', async (req, res) => {
    res.json({ success: true, message: 'Continuous check started' });
    const allJobs = await readFromFirebase('Jobs');
    if (allJobs) {
        for (const [id, job] of Object.entries(allJobs)) {
            if (job.status === 'waiting_chapters' || job.pending === true) {
                await processMangaJob(id, job);
                await new Promise(r => setTimeout(r, 2000));
            }
        }
    }
});

app.get('/', (req, res) => { res.send('<h1>⚙️ السيرفر الثاني - معالج الفصول V3 Fixed</h1>'); });

app.listen(PORT, () => {
    console.log(`Server 2 running on port ${PORT}`);
    // فحص كل 10 دقائق
    setInterval(async () => { 
        try { 
            await axios.get(`http://localhost:${PORT}/start-continuous-check`); 
        } catch(e){} 
    }, 1000 * 60 * 10);
});
