const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const PORT = process.env.PORT || 3001;
const DATABASE_SECRETS = "KXPNxnGZDA1BGnzs4kZIA45o6Vr9P5nJ3Z01X4bt";
const DATABASE_URL = "https://hackerdz-b1bdf.firebaseio.com";

const SYSTEM_CONFIG = {
    MAX_CHAPTERS_PER_GROUP: 300,
    CHAPTER_GROUP_PREFIX: 'ImgChapter',
    DELAY_BETWEEN_CHAPTERS: 1500, // تأخير بسيط بين الفصول
    MAX_IMAGES: 100
};

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// ==================== Firebase Helpers ====================
async function writeToFirebase(path, data) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try { await axios.put(url, data); } catch (e) { console.error(`Firebase Write Error: ${path}`); }
}

async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try { const res = await axios.get(url); return res.data; } catch (e) { return null; }
}

// ==================== إدارة مجموعات الفصول ====================
async function getChapterGroup() {
    let stats = await readFromFirebase('System/chapter_stats');
    if (!stats) stats = { currentGroup: 1, currentGroupCount: 0 };
    
    if (stats.currentGroupCount >= SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP) {
        stats.currentGroup++;
        stats.currentGroupCount = 0;
    }
    
    // تحديث العداد محلياً (سنحدثه في القاعدة لاحقاً لتوفير الطلبات)
    return { 
        groupName: `${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_${stats.currentGroup}`,
        stats: stats 
    };
}

async function updateChapterStats(stats) {
    stats.currentGroupCount++;
    stats.totalChapters = (stats.totalChapters || 0) + 1;
    await writeToFirebase('System/chapter_stats', stats);
}

// ==================== أدوات الجلب (Headers القوية) ====================
function getHeaders(referer = 'https://azoramoon.com/') {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer, // مهم جداً للصور
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };
}

async function fetchWithRetry(url, referer) {
    for (let i = 0; i < 3; i++) {
        try {
            const res = await axios.get(url, { headers: getHeaders(referer), timeout: 20000 });
            return res.data;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error('Failed to fetch after 3 retries');
}

// ==================== منطق استخراج الصور ====================
function extractImages(html) {
    const $ = cheerio.load(html);
    const images = [];
    
    // محددات الصور الشائعة في قوالب المانجا
    const selectors = ['.reading-content img', '.wp-manga-chapter-img', '#readerarea img', 'img[class*="wp-manga"]'];
    
    for (const sel of selectors) {
        $(sel).each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
            if (src) {
                src = src.trim().replace(/^\/\//, 'https://');
                if (!images.includes(src)) images.push(src);
            }
        });
        if (images.length > 0) break; // إذا وجدنا صور بمحدد، نتوقف
    }
    return images;
}

// ==================== منطق استخراج الفصول ====================
function extractChapters(html) {
    const $ = cheerio.load(html);
    const chapters = [];
    
    $('.wp-manga-chapter, .chapter-item, li.wp-manga-chapter').each((i, el) => {
        const a = $(el).find('a');
        const url = a.attr('href');
        const title = a.text().trim();
        
        if (url) {
            // استخراج الرقم لترتيب أفضل
            const numMatch = title.match(/(\d+(\.\d+)?)/);
            const num = numMatch ? parseFloat(numMatch[0]) : 0;
            const id = `ch_${num.toString().replace('.', '_')}`;
            
            chapters.push({ id, num, title, url });
        }
    });
    
    // ترتيب تصاعدي (من 1 إلى الأحدث)
    return chapters.sort((a, b) => a.num - b.num);
}

// ==================== المعالج الرئيسي ====================
async function processFullManga(mangaId, mangaUrl) {
    console.log(`⚙️ معالجة شاملة: ${mangaId}`);
    
    try {
        // 1. جلب صفحة المانجا لاستخراج الفصول
        const html = await fetchWithRetry(mangaUrl);
        const chapters = extractChapters(html);
        
        if (chapters.length === 0) {
            console.log(`⚠️ لا توجد فصول: ${mangaId}`);
            return;
        }

        console.log(`📚 وجد ${chapters.length} فصل.`);

        // 2. التحقق من الفصول الموجودة مسبقاً لتجنب التكرار
        // هذه الخطوة اختيارية لتقليل القراءة، لكن يفضل عملها
        // سنقوم بالمعالجة المباشرة للفصول الجديدة فقط
        
        // جلب معلومات المجموعة الحالية
        let { groupName, stats } = await getChapterGroup();
        
        // 3. معالجة كل فصل
        for (const chapter of chapters) {
            // التحقق السريع (يمكن تحسينه بقراءة المانجا مرة واحدة)
            const chapterPath = `${groupName}/${mangaId}/chapters/${chapter.id}`;
            const exists = await readFromFirebase(chapterPath);
            
            if (!exists || !exists.images) {
                console.log(`📥 جلب صور الفصل: ${chapter.title}`);
                
                try {
                    // جلب صور الفصل فوراً
                    const chapterHtml = await fetchWithRetry(chapter.url, mangaUrl);
                    const images = extractImages(chapterHtml);
                    
                    if (images.length > 0) {
                        const chapterData = {
                            ...chapter,
                            images: images,
                            totalImages: images.length,
                            savedAt: Date.now()
                        };
                        
                        // حفظ الفصل مع صوره مباشرة
                        await writeToFirebase(chapterPath, chapterData);
                        
                        // تحديث العدادات
                        await updateChapterStats(stats);
                        
                        // إذا امتلأت المجموعة، ننتقل للتالية
                        if (stats.currentGroupCount >= SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP) {
                            const newGroupInfo = await getChapterGroup();
                            groupName = newGroupInfo.groupName;
                            stats = newGroupInfo.stats;
                        }
                    } else {
                        console.log(`⚠️ فصل فارغ: ${chapter.title}`);
                    }
                    
                    // تأخير لتجنب الحظر
                    await new Promise(r => setTimeout(r, SYSTEM_CONFIG.DELAY_BETWEEN_CHAPTERS));
                    
                } catch (err) {
                    console.error(`❌ خطأ في الفصل ${chapter.id}: ${err.message}`);
                }
            }
        }
        console.log(`✅ تمت معالجة المانجا: ${mangaId}`);
        
    } catch (error) {
        console.error(`❌ خطأ كبير في المانجا ${mangaId}: ${error.message}`);
    }
}

// ==================== الخادم ====================
const app = express();

app.get('/process-full/:mangaId', async (req, res) => {
    const { mangaId } = req.params;
    const { url } = req.query;
    
    if (!url) return res.status(400).send('URL required');
    
    // نرد فوراً لكي لا ينتظر البوت الأول
    res.json({ success: true, message: 'Processing started in background' });
    
    // العمل في الخلفية
    processFullManga(mangaId, url);
});

app.get('/', (req, res) => res.send('Bot 2 (Super Worker) is Ready.'));

app.listen(PORT, () => {
    console.log(`✅ البوت 2 (الشامل) يعمل على المنفذ ${PORT}`);
});
