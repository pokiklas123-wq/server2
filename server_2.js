const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

// ==================== متغيرات البيئة ====================
const PORT = process.env.PORT || 3001;
const DATABASE_SECRETS = process.env.DATABASE_SECRETS || "KXPNxnGZDA1BGnzs4kZIA45o6Vr9P5nJ3Z01X4bt";
const DATABASE_URL = process.env.DATABASE_URL || "https://hackerdz-b1bdf.firebaseio.com";
const SERVER_3_URL = process.env.SERVER_3_URL || 'http://localhost:3002';

// ==================== إعدادات النظام ====================
const SYSTEM_CONFIG = {
    MAX_CHAPTERS_PER_GROUP: 300,          // 300 فصل في كل مجموعة ImgChapter
    CHAPTER_GROUP_PREFIX: 'ImgChapter',    // ImgChapter_1, ImgChapter_2
    DELAY_BETWEEN_CHAPTERS: 2000,          // 2 ثواني بين الفصول
    USE_DIRECT_LINKS: true,               // استخدام الروابط المباشرة
    MAX_FETCH_RETRIES: 3                  // 3 محاولات للجلب
};

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
            return null;
        }
        console.error(`❌ فشل القراءة من Firebase في ${path}:`, error.message);
        throw error;
    }
}

// ==================== نظام المجموعات للفصول ====================
class ChapterGroupManager {
    constructor() {
        this.groupCounter = 1;
        this.currentGroupCount = 0;
        this.totalChaptersSaved = 0;
    }
    
    // تحديد مجموعة الفصول للمانجا
    async getChapterGroupForManga(mangaId) {
        // البحث عن المانجا في مجموعات HomeManga
        let mangaData = null;
        let mangaGroup = null;
        
        // البحث في جميع مجموعات HomeManga
        for (let i = 1; i <= 52; i++) {
            const groupName = `HomeManga_${i}`;
            const data = await readFromFirebase(`${groupName}/${mangaId}`);
            if (data) {
                mangaData = data;
                mangaGroup = groupName;
                break;
            }
        }
        
        if (!mangaData) {
            throw new Error(`المانجا ${mangaId} غير موجودة في أي مجموعة`);
        }
        
        // الحصول على إحصائيات الفصول
        const stats = await readFromFirebase(`System/chapter_stats`) || {
            currentGroup: 1,
            currentGroupCount: 0,
            totalChapters: 0
        };
        
        this.groupCounter = stats.currentGroup || 1;
        this.currentGroupCount = stats.currentGroupCount || 0;
        this.totalChaptersSaved = stats.totalChapters || 0;
        
        // إذا كانت المجموعة الحالية ممتلئة، الانتقال للمجموعة التالية
        if (this.currentGroupCount >= SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP) {
            this.groupCounter++;
            this.currentGroupCount = 0;
            console.log(`🔄 الانتقال إلى مجموعة الفصول ${this.groupCounter}`);
        }
        
        const chapterGroup = `${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_${this.groupCounter}`;
        
        // زيادة العداد
        this.currentGroupCount++;
        this.totalChaptersSaved++;
        
        // حفظ الإحصائيات
        await writeToFirebase(`System/chapter_stats`, {
            currentGroup: this.groupCounter,
            currentGroupCount: this.currentGroupCount,
            totalChapters: this.totalChaptersSaved,
            lastUpdate: Date.now()
        });
        
        return chapterGroup;
    }
    
    // حفظ فصل في المجموعة المناسبة
    async saveChapterToGroup(mangaId, chapterData) {
        const chapterGroup = await this.getChapterGroupForManga(mangaId);
        
        // إنشاء معرف آمن للفصل
        const chapterId = chapterData.safeChapterId || 
                         `ch_${chapterData.chapterNumber.toString().replace(/[^\w]/g, '_')}`;
        
        const path = `${chapterGroup}/${mangaId}/chapters/${chapterId}`;
        
        // حفظ بيانات الفصل
        const fullChapterData = {
            ...chapterData,
            mangaId: mangaId,
            chapterGroup: chapterGroup,
            savedAt: Date.now(),
            chapterNumber: chapterData.chapterNumber || 0
        };
        
        await writeToFirebase(path, fullChapterData);
        
        // تسجيل في الفهرس
        await writeToFirebase(`Index/chapters/${mangaId}/${chapterId}`, {
            title: chapterData.title,
            group: chapterGroup,
            chapterNumber: chapterData.chapterNumber,
            savedAt: Date.now()
        });
        
        console.log(`✅ تم حفظ الفصل في ${chapterGroup}`);
        
        return {
            saved: true,
            chapterId: chapterId,
            group: chapterGroup,
            path: path
        };
    }
}

const chapterGroupManager = new ChapterGroupManager();

// ==================== دوال مساعدة للفصول ====================
function generateSafeChapterId(chapterNumber) {
    return `ch_${chapterNumber.toString().replace(/[^\w]/g, '_')}`;
}

function cleanChapterNumber(chapterStr) {
    const match = chapterStr.match(/(\d+(\.\d+)?)/);
    return match ? parseFloat(match[1]) : 0;
}

// ==================== إعدادات الجلب ====================
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

function getRandomHeaders() {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    return { 'User-Agent': userAgent };
}

async function fetchWithRetry(url, maxRetries = SYSTEM_CONFIG.MAX_FETCH_RETRIES) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.get(url, {
                headers: getRandomHeaders(),
                timeout: 15000
            });
            return response.data;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
    }
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
                    const chapterNum = cleanChapterNumber(chapterTitle);
                    const safeChapterId = generateSafeChapterId(chapterNum || i + 1);
                    
                    chapters.push({
                        chapterId: safeChapterId,
                        chapterNumber: chapterNum || i + 1,
                        title: chapterTitle,
                        url: chapterLink.startsWith('http') ? chapterLink : `https://azoramoon.com${chapterLink}`,
                        status: 'pending_images',
                        createdAt: Date.now(),
                        safeChapterId: safeChapterId,
                        mangaTitle: $('title').text().trim() || 'غير معروف'
                    });
                }
            });
            return chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        }
    }
    
    return [];
}

// ==================== معالجة المانجا ====================
async function processManga(mangaId, groupName) {
    console.log(`\n🎯 بدء معالجة المانجا: ${mangaId} (${groupName})`);
    
    try {
        // جلب بيانات المانجا من المجموعة
        const mangaData = await readFromFirebase(`${groupName}/${mangaId}`);
        
        if (!mangaData) {
            console.error(`❌ المانجا ${mangaId} غير موجودة في ${groupName}`);
            return { success: false, message: 'المانجا غير موجودة' };
        }
        
        console.log(`📖 المانجا: ${mangaData.title}`);
        console.log(`🔗 الرابط: ${mangaData.url}`);
        
        // جلب الفصول من الموقع
        const scrapedChapters = await getChaptersFromUrl(mangaData.url);
        
        if (scrapedChapters.length === 0) {
            console.log('⚠️ لم يتم العثور على أي فصول.');
            
            // تحديث حالة المانجا
            await writeToFirebase(`${groupName}/${mangaId}`, {
                ...mangaData,
                status: 'no_chapters_found',
                lastChecked: Date.now()
            });
            
            return { success: false, message: 'لم يتم العثور على أي فصول' };
        }
        
        console.log(`📊 تم العثور على ${scrapedChapters.length} فصل`);
        
        let newChaptersCount = 0;
        let savedChapters = [];
        
        // حفظ كل الفصول
        for (const chapter of scrapedChapters) {
            // التحقق من وجود الفصل في أي مجموعة
            let chapterExists = false;
            
            // البحث في جميع مجموعات الفصول
            const stats = await readFromFirebase(`System/chapter_stats`) || {};
            const maxChapterGroup = stats.currentGroup || 1;
            
            for (let g = 1; g <= maxChapterGroup; g++) {
                const chapterGroup = `ImgChapter_${g}`;
                const existingChapter = await readFromFirebase(`${chapterGroup}/${mangaId}/chapters/${chapter.chapterId}`);
                
                if (existingChapter) {
                    chapterExists = true;
                    break;
                }
            }
            
            if (!chapterExists) {
                // حفظ الفصل الجديد
                const result = await chapterGroupManager.saveChapterToGroup(mangaId, chapter);
                
                if (result.saved) {
                    newChaptersCount++;
                    savedChapters.push(chapter);
                    
                    console.log(`✨ فصل جديد: ${chapter.title}`);
                    
                    // إخطار البوت 3
                    await notifyServer3(mangaId, chapter, result.group);
                    
                    // تأخير بين الفصول
                    await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_CHAPTERS));
                }
            }
        }
        
        // تحديث حالة المانجا
        await writeToFirebase(`${groupName}/${mangaId}`, {
            ...mangaData,
            status: newChaptersCount > 0 ? 'new_chapters_added' : 'up_to_date',
            chaptersCount: scrapedChapters.length,
            newChaptersCount: newChaptersCount,
            lastChecked: Date.now(),
            lastUpdated: Date.now()
        });
        
        console.log(`✅ انتهت معالجة المانجا`);
        console.log(`📊 فصول جديدة: ${newChaptersCount}/${scrapedChapters.length}`);
        
        return { 
            success: true, 
            message: `تم العثور على ${newChaptersCount} فصل جديد`,
            totalChapters: scrapedChapters.length,
            newChapters: newChaptersCount,
            savedChapters: savedChapters
        };
        
    } catch (error) {
        console.error(`❌ خطأ في معالجة المانجا ${mangaId}:`, error.message);
        
        // تحديث حالة الخطأ
        try {
            const mangaData = await readFromFirebase(`${groupName}/${mangaId}`);
            if (mangaData) {
                await writeToFirebase(`${groupName}/${mangaId}`, {
                    ...mangaData,
                    status: 'error',
                    error: error.message,
                    lastChecked: Date.now()
                });
            }
        } catch (e) {
            console.error('❌ فشل تحديث حالة الخطأ:', e.message);
        }
        
        return { success: false, error: error.message };
    }
}

async function getChaptersFromUrl(url) {
    console.log(`🔗 جلب الفصول من: ${url}`);
    try {
        const html = await fetchWithRetry(url);
        return extractChapters(html);
    } catch (error) {
        console.error(`❌ فشل جلب الفصول: ${error.message}`);
        return [];
    }
}

// ==================== إخطار البوت 3 ====================
async function notifyServer3(mangaId, chapterData, chapterGroup) {
    if (!SERVER_3_URL) {
        console.log('⚠️ لم يتم تحديد SERVER_3_URL.');
        return;
    }
    
    const url = `${SERVER_3_URL}/process-chapter/${mangaId}/${chapterData.chapterId}?group=${chapterGroup}`;
    console.log(`🔔 إخطار البوت 3: ${mangaId}/${chapterData.chapterId} (${chapterGroup})`);
    
    try {
        const response = await axios.get(url, { timeout: 10000 });
        console.log(`✅ استجابة البوت 3: ${response.data.message || 'تم الإخطار'}`);
    } catch (error) {
        console.error(`❌ فشل إخطار البوت 3: ${error.message}`);
    }
}

// ==================== محرك الفحص المستمر ====================
async function continuousMangaCheck() {
    console.log('\n🔍 بدء الفحص المستمر للمانجا...');
    
    while (true) {
        try {
            let processedCount = 0;
            
            // فحص جميع مجموعات HomeManga
            for (let groupNum = 1; groupNum <= 52; groupNum++) {
                const groupName = `HomeManga_${groupNum}`;
                console.log(`\n📁 فحص المجموعة: ${groupName}`);
                
                // جلب جميع المانجا في هذه المجموعة
                const groupData = await readFromFirebase(groupName);
                
                if (groupData && typeof groupData === 'object') {
                    const mangaIds = Object.keys(groupData);
                    console.log(`📊 عدد المانجا في ${groupName}: ${mangaIds.length}`);
                    
                    for (const mangaId of mangaIds) {
                        const manga = groupData[mangaId];
                        
                        // معالجة المانجا التي تحتاج فحص
                        if (manga && (manga.status === 'pending_chapters' || 
                                      manga.status === 'error' ||
                                      manga.status === 'new_chapters_added')) {
                            
                            console.log(`\n🎯 معالجة: ${manga.title || mangaId}`);
                            console.log(`📁 المجموعة: ${groupName}`);
                            console.log(`📊 الحالة: ${manga.status}`);
                            
                            await processManga(mangaId, groupName);
                            processedCount++;
                            
                            // تأخير بين المانجا
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                    }
                }
                
                // تأخير بين المجموعات
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            
            console.log(`\n📊 الفحص اكتمل. تم معالجة ${processedCount} مانجا`);
            
            // إذا لم يتم معالجة أي مانجا، انتظر وقتاً أطول
            const waitTime = processedCount > 0 ? 60000 : 300000; // 1 دقيقة أو 5 دقائق
            console.log(`⏳ الانتظار ${waitTime / 1000} ثانية للفحص التالي...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
        } catch (error) {
            console.error('❌ خطأ في محرك الفحص المستمر:', error.message);
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
}

// ==================== واجهات API ====================
const app = express();

app.get('/process-manga/:mangaId', async (req, res) => {
    const { mangaId } = req.params;
    const { group } = req.query;
    
    try {
        if (!group) {
            return res.status(400).json({ 
                success: false, 
                message: 'يرجى تحديد اسم المجموعة (?group=HomeManga_X)' 
            });
        }
        
        // بدء المعالجة في الخلفية
        processManga(mangaId, group);
        
        res.json({ 
            success: true, 
            message: 'بدأت معالجة الفصول',
            mangaId: mangaId,
            group: group
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

app.get('/stats', async (req, res) => {
    try {
        const chapterStats = await readFromFirebase('System/chapter_stats') || {};
        
        // حساب إجمالي الفصول في جميع المجموعات
        let totalChapters = 0;
        for (let g = 1; g <= (chapterStats.currentGroup || 1); g++) {
            const groupName = `ImgChapter_${g}`;
            const groupData = await readFromFirebase(groupName);
            if (groupData) {
                // حساب الفصول في هذه المجموعة
                let groupChapters = 0;
                for (const mangaId in groupData) {
                    if (groupData[mangaId] && groupData[mangaId].chapters) {
                        groupChapters += Object.keys(groupData[mangaId].chapters).length;
                    }
                }
                totalChapters += groupChapters;
            }
        }
        
        res.json({
            success: true,
            system: SYSTEM_CONFIG,
            chapterStats: chapterStats,
            totalChapters: totalChapters,
            groups: Array.from({length: chapterStats.currentGroup || 1}, (_, i) => 
                `${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_${i + 1}`
            )
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <h1>📖 البوت 2 - معالج الفصول</h1>
        <p><strong>نظام المجموعات:</strong> ${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_1 إلى ${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_N</p>
        <p><strong>الفصول في كل مجموعة:</strong> ${SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP}</p>
        <p><strong>التأخير بين الفصول:</strong> ${SYSTEM_CONFIG.DELAY_BETWEEN_CHAPTERS}ms</p>
        
        <h3>الروابط:</h3>
        <p><a href="/stats">/stats</a> - إحصائيات الفصول</p>
        
        <h3>هيكل التخزين:</h3>
        <pre>${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_1/
└── manga_id_1/
    └── chapters/
        ├── ch_1
        ├── ch_2
        └── ...

${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_2/
└── manga_id_1/
    └── chapters/
        ├── ch_301
        └── ...</pre>
    `);
});

app.listen(PORT, () => {
    console.log(`\n✅ البوت 2 يعمل على المنفذ ${PORT}`);
    console.log(`📊 نظام الفصول:`);
    console.log(`   • البادئة: ${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_#`);
    console.log(`   • فصول/مجموعة: ${SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP}`);
    console.log(`   • التأخير: ${SYSTEM_CONFIG.DELAY_BETWEEN_CHAPTERS}ms`);
    
    // بدء الفحص المستمر
    setTimeout(() => {
        continuousMangaCheck();
    }, 5000);
});
