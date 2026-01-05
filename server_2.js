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
                const chapterLink = $el.find('a').attr('href');
                const chapterTitle = $el.find('a').text().trim();
                
                if (chapterLink && chapterTitle) {
                    const chapterNumMatch = chapterTitle.match(/(\d+(\.\d+)?)/);
                    const chapterNum = chapterNumMatch ? parseFloat(chapterNumMatch[1]) : (i + 1) * 0.01; // رقم فريد تقريبي
                    
                    // استخدام رابط الفصل كمعرف فريد
                    const chapterId = crypto.createHash('md5').update(chapterLink).digest('hex').substring(0, 12);
                    
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
            // نأخذ أول مجموعة ناجحة من الفصول
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
        // 1. جلب الفصول الحالية من الموقع
        const scrapedChapters = await getChaptersWithRetry(job.mangaUrl);
        
        if (scrapedChapters.length === 0) {
            console.log('⚠️ لم يتم العثور على أي فصول. إنهاء المعالجة.');
            await writeToFirebase(`Jobs/${mangaId}`, { ...job, status: 'no_chapters_found', lastRun: Date.now() });
            return { success: false, message: 'لم يتم العثور على أي فصول' };
        }
        
        // 2. قراءة الفصول الموجودة في Firebase
        const existingChapters = await readFromFirebase(`ImgChapter/${mangaId}`) || {};
        
        let newChaptersCount = 0;
        
        // 3. مقارنة وحفظ الفصول الجديدة
        for (const chapter of scrapedChapters) {
            // نستخدم chapter.chapterId كمعرف فريد
            if (!existingChapters[chapter.chapterId]) {
                // فصل جديد
                await writeToFirebase(`ImgChapter/${mangaId}/${chapter.chapterId}`, chapter);
                console.log(`✨ فصل جديد: ${chapter.title}`);
                newChaptersCount++;
                
                // 4. إخطار البوت 3
                await notifyServer3(mangaId, chapter.chapterId);
            }
        }
        
        // 5. تحديث حالة المهمة
        const newStatus = newChaptersCount > 0 ? 'new_chapters_found' : 'no_new_chapters';
        await writeToFirebase(`Jobs/${mangaId}`, { 
            ...job, 
            status: newStatus, 
            chaptersCount: scrapedChapters.length,
            lastRun: Date.now() 
        });
        
        console.log(`✅ انتهت معالجة المانجا. فصول جديدة: ${newChaptersCount}`);
        return { success: true, message: `تم العثور على ${newChaptersCount} فصل جديد/محدث.` };
        
    } catch (error) {
        console.error(`❌ خطأ في معالجة المانجا ${mangaId}:`, error.message);
        await writeToFirebase(`Jobs/${mangaId}`, { ...job, status: 'error', error: error.message, lastRun: Date.now() });
        return { success: false, error: error.message };
    }
}

// ==================== واجهات API ====================
const app = express();

// 🎯 API يستدعيه البوت 1 لإخطاره بمانجا جديدة/محدثة
app.get('/process-manga/:mangaId', async (req, res) => {
    const { mangaId } = req.params;
    console.log(`\n🚀 طلب معالجة المانجا من البوت 1: ${mangaId}`);
    
    try {
        const job = await readFromFirebase(`Jobs/${mangaId}`);
        
        if (!job) {
            return res.status(404).json({ success: false, message: 'لم يتم العثور على المهمة' });
        }
        
        const result = await processMangaJob(mangaId, job);
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🔄 API للتحقق المستمر (يتم استدعاؤه بواسطة Render Cron Job)
app.get('/start-continuous-check', async (req, res) => {
    console.log('\n🔄 بدء التحقق المستمر من المهام المعلقة...');
    
    try {
        const allJobs = await readFromFirebase('Jobs');
        let processedCount = 0;
        
        if (allJobs) {
            for (const [mangaId, job] of Object.entries(allJobs)) {
                // معالجة المهام التي فشلت أو التي تم إخطارها من البوت 1
                if (job && (job.status === 'waiting_chapters' || job.status === 'error' || job.status === 'no_new_chapters')) {
                    await processMangaJob(mangaId, job);
                    processedCount++;
                    // تأخير بسيط لتجنب الضغط على Firebase
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }
        
        res.json({
            success: true,
            message: `تم فحص ${Object.keys(allJobs || {}).length} مهمة. تم معالجة ${processedCount} مهمة.`
        });
        
    } catch (error) {
        console.error('❌ خطأ في التحقق المستمر:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🏠 الصفحة الرئيسية المبسطة
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html dir="rtl" lang="ar">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>📖 البوت 2 - معالج الفصول</title>
            <style>
                body { font-family: 'Arial', sans-serif; margin: 20px; background: #f5f5f5; text-align: right; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #333; border-bottom: 3px solid #4CAF50; padding-bottom: 10px; }
                ul { list-style: none; padding: 0; }
                li { margin: 10px 0; padding: 10px; background: #f9f9f9; border-radius: 5px; border-right: 4px solid #4CAF50; }
                a { color: #2196F3; text-decoration: none; font-weight: bold; }
                a:hover { text-decoration: underline; }
                .status { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 0.9em; }
                .success { background: #d4edda; color: #155724; }
                .error { background: #f8d7da; color: #721c24; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📖 البوت 2 - معالج الفصول</h1>
                
                <h2>⚙️ حالة النظام:</h2>
                <ul>
                    <li>Firebase: <span class="status ${DATABASE_SECRETS ? 'success' : 'error'}">${DATABASE_SECRETS ? '✅ متصل' : '❌ غير متصل'}</span></li>
                    <li>البوت 3 URL: <span class="status ${SERVER_3_URL ? 'success' : 'error'}">${SERVER_3_URL ? '✅ محدد' : '❌ مفقود'}</span></li>
                    <li>المنفذ: <span class="status success">${PORT}</span></li>
                </ul>
                
                <h2>🎯 الروابط الرئيسية:</h2>
                <ul>
                    <li><a href="/start-continuous-check">/start-continuous-check</a> - بدء التحقق المستمر (يجب أن يتم استدعاؤه بواسطة Render Cron Job)</li>
                    <li>/process-manga/:mangaId - يستدعيه البوت 1</li>
                </ul>
                
                <h2>📝 ملاحظة:</h2>
                <p>هذا البوت يعمل بشكل آلي. يجب إعداد Render Cron Job لاستدعاء <code>/start-continuous-check</code> بشكل دوري (مثلاً كل 10 دقائق) لضمان معالجة جميع المهام المعلقة.</p>
            </div>
        </body>
        </html>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`\n✅ البوت 2 (معالج الفصول) يعمل على المنفذ ${PORT}`);
    console.log(`🎯 جاهز لمعالجة الفصول...`);
});
