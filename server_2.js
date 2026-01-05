const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

// ==================== متغيرات البيئة ====================
const PORT = process.env.PORT || 10000;
const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;
const SERVER_3_URL = process.env.SERVER_3_URL; // متغير بيئة جديد للاتصال بالبوت 3

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// ==================== دوال Firebase ====================
async function writeToFirebase(path, data) {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.error('❌ خطأ: متغيرات Firebase غير موجودة.');
        return;
    }
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        await axios.put(url, data);
    } catch (error) {
        console.error(`❌ فشل الكتابة إلى Firebase في ${path}:`, error.message);
        throw error;
    }
}

async function readFromFirebase(path) {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.error('❌ خطأ: متغيرات Firebase غير موجودة.');
        return null;
    }
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null; // لا يوجد بيانات
        }
        console.error(`❌ فشل القراءة من Firebase في ${path}:`, error.message);
        throw error;
    }
}

// ==================== إعدادات الجلب (مختصرة) ====================
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

const PROXIES = [
    '', // بدون بروكسي أولاً
    'https://cors-anywhere.herokuapp.com/',
    'https://api.allorigins.win/raw?url='
];

function getRandomHeaders() {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    return { 'User-Agent': userAgent };
}

async function tryAllProxies(url) {
    for (const proxy of PROXIES) {
        try {
            let targetUrl = url;
            if (proxy) {
                targetUrl = proxy + encodeURIComponent(url);
            }
            const response = await axios.get(targetUrl, {
                headers: getRandomHeaders(),
                timeout: 20000
            });
            if (response.status === 200) return response.data;
        } catch (error) {
            // تجاهل الخطأ والمحاولة مع البروكسي التالي
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('فشلت جميع محاولات الجلب');
}

// ==================== منطق استخراج الفصول ====================

function extractChapters(html) {
    const $ = cheerio.load(html);
    const chapters = [];
    const chapterSelectors = [
        '.wp-manga-chapter',
        '.chapter-item',
        '.listing-chapters_wrap a',
        'ul.main.version-chap li'
    ];
    
    for (const selector of chapterSelectors) {
        const elements = $(selector);
        if (elements.length > 0) {
            elements.each((i, element) => {
                const $el = $(element);
                const chapterLink = $el.find('a').attr('href') || $el.attr('href');
                const chapterTitle = $el.find('a').text().trim() || $el.text().trim();
                
                if (chapterLink && chapterTitle) {
                    const chapterNumMatch = chapterTitle.match(/(\d+(\.\d+)?)/);
                    const chapterNum = chapterNumMatch ? parseFloat(chapterNumMatch[1]) : (i + 1) * 0.01;
                    
                    // استخدام رقم الفصل كمعرف فريد لتسهيل الترتيب
                    const chapterId = chapterNum.toString().replace('.', '_');
                    
                    chapters.push({
                        chapterId: chapterId,
                        chapterNumber: chapterNum,
                        title: chapterTitle,
                        url: chapterLink.startsWith('http') ? chapterLink : `https://azoramoon.com${chapterLink}`,
                        status: 'pending_images',
                        createdAt: Date.now()
                    });
                }
            });
            return chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        }
    }
    
    return [];
}

async function getChaptersWithRetry(url) {
    console.log(`🔗 جلب الفصول من: ${url}`);
    const html = await tryAllProxies(url);
    return extractChapters(html);
}

// ==================== منطق التتابع والاتصال ====================

async function notifyServer3(mangaId, chapterId) {
    if (!SERVER_3_URL) {
        console.log('⚠️ لم يتم تحديد SERVER_3_URL. لن يتم إخطار البوت 3.');
        return;
    }
    
    const url = `${SERVER_3_URL}/process-chapter/${mangaId}/${chapterId}`;
    console.log(`\n🔔 إخطار البوت 3 لبدء معالجة الفصل: ${mangaId}/${chapterId}`);
    
    try {
        const response = await axios.get(url, { timeout: 10000 });
        console.log(`✅ استجابة البوت 3: ${response.data.message || 'تم الإخطار بنجاح'}`);
    } catch (error) {
        console.error(`❌ فشل إخطار البوت 3: ${error.message}`);
    }
}

async function processMangaJob(mangaId, job) {
    console.log(`\n🎯 بدء معالجة المانجا: ${job.title} (${mangaId})`);
    
    try {
        const scrapedChapters = await getChaptersWithRetry(job.mangaUrl);
        
        if (scrapedChapters.length === 0) {
            console.log('⚠️ لم يتم العثور على أي فصول.');
            await writeToFirebase(`Jobs/${mangaId}`, { ...job, status: 'no_chapters_found', lastRun: Date.now() });
            return { success: false, message: 'لم يتم العثور على أي فصول' };
        }
        
        // قراءة الفصول الموجودة تحت ImgChapter/manga_id/chapters/
        const existingData = await readFromFirebase(`ImgChapter/${mangaId}/chapters`) || {};
        
        let newChaptersCount = 0;
        
        for (const chapter of scrapedChapters) {
            if (!existingData[chapter.chapterId]) {
                // حفظ الفصل الجديد
                await writeToFirebase(`ImgChapter/${mangaId}/chapters/${chapter.chapterId}`, chapter);
                console.log(`✨ فصل جديد: ${chapter.title}`);
                newChaptersCount++;
                
                // إخطار البوت 3
                await notifyServer3(mangaId, chapter.chapterId);
            }
        }
        
        const newStatus = newChaptersCount > 0 ? 'new_chapters_found' : 'no_new_chapters';
        await writeToFirebase(`Jobs/${mangaId}`, { 
            ...job, 
            status: newStatus, 
            chaptersCount: scrapedChapters.length,
            lastRun: Date.now() 
        });
        
        console.log(`✅ انتهت معالجة المانجا. فصول جديدة: ${newChaptersCount}`);
        return { success: true, message: `تم العثور على ${newChaptersCount} فصل جديد.` };
        
    } catch (error) {
        console.error(`❌ خطأ في معالجة المانجا ${mangaId}:`, error.message);
        await writeToFirebase(`Jobs/${mangaId}`, { ...job, status: 'error', error: error.message, lastRun: Date.now() });
        return { success: false, error: error.message };
    }
}

// ==================== واجهات API ====================
const app = express();

app.get('/process-manga/:mangaId', async (req, res) => {
    const { mangaId } = req.params;
    try {
        const job = await readFromFirebase(`Jobs/${mangaId}`);
        if (!job) return res.status(404).json({ success: false, message: 'لم يتم العثور على المهمة' });
        
        // المعالجة في الخلفية
        processMangaJob(mangaId, job);
        res.json({ success: true, message: 'بدأت معالجة الفصول.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// محرك الفحص المستمر للمهام المعلقة (لضمان الاستمرارية)
async function continuousJobCheck() {
    while (true) {
        try {
            const allJobs = await readFromFirebase('Jobs');
            if (allJobs) {
                for (const [mangaId, job] of Object.entries(allJobs)) {
                    if (job && (job.status === 'waiting_chapters' || job.status === 'error')) {
                        await processMangaJob(mangaId, job);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
        } catch (error) {
            console.error('❌ خطأ في محرك الفحص المستمر:', error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 60000)); // فحص كل دقيقة
    }
}

app.get('/', (req, res) => {
    res.send(`<h1>📖 البوت 2 - معالج الفصول (معدل)</h1>`);
});

app.listen(PORT, () => {
    console.log(`\n✅ البوت 2 يعمل على المنفذ ${PORT}`);
    continuousJobCheck();
});