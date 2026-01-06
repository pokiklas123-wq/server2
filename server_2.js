const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

// ==================== متغيرات البيئة ====================
const PORT = process.env.PORT || 3001;
const DATABASE_SECRETS = "KXPNxnGZDA1BGnzs4kZIA45o6Vr9P5nJ3Z01X4bt"; // يجب أن يكون هذا سراً
const DATABASE_URL = "https://hackerdz-b1bdf.firebaseio.com";
// **التعديل 1: إضافة رابط البوت 3 للاتصال به**
const SERVER_3_URL = "https://server-3-frfj.onrender.com"; 

// ==================== إعدادات النظام ====================
const SYSTEM_CONFIG = {
    MAX_CHAPTERS_PER_GROUP: 300,
    CHAPTER_GROUP_PREFIX: 'ImgChapter',
    DELAY_BETWEEN_CHAPTERS: 2000,
    DELAY_BETWEEN_MANGA: 3000,
    DELAY_BETWEEN_GROUPS: 2000,
    MAX_FETCH_RETRIES: 3,
    MAX_MANGA_PER_CYCLE: 20,
    // **التعديل 2: إضافة بادئة مجموعة المانجا من البوت 1**
    GROUP_PREFIX: 'HomeManga' 
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
    
    async initialize() {
        const stats = await readFromFirebase('System/chapter_stats') || {
            currentGroup: 1,
            currentGroupCount: 0,
            totalChapters: 0
        };
        
        this.groupCounter = stats.currentGroup || 1;
        this.currentGroupCount = stats.currentGroupCount || 0;
        this.totalChaptersSaved = stats.totalChapters || 0;
    }
    
    async getChapterGroup() {
        // **التعديل 3: تحديث منطق الحصول على المجموعة قبل الزيادة**
        const stats = await readFromFirebase('System/chapter_stats') || {
            currentGroup: 1,
            currentGroupCount: 0,
            totalChapters: 0
        };
        this.groupCounter = stats.currentGroup || 1;
        this.currentGroupCount = stats.currentGroupCount || 0;

        if (this.currentGroupCount >= SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP) {
            this.groupCounter++;
            this.currentGroupCount = 0;
            console.log(`🔄 الانتقال إلى مجموعة الفصول ${this.groupCounter}`);
        }
        
        return `${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_${this.groupCounter}`;
    }
    
    async saveChapter(mangaId, chapterData) {
        const chapterGroup = await this.getChapterGroup();
        const chapterId = chapterData.safeChapterId || `ch_${chapterData.chapterNumber.toString().replace(/[^\w]/g, '_')}`;
        
        // إنشاء الهيكل الكامل
        const chapterPath = `${chapterGroup}/${mangaId}/chapters/${chapterId}`;
        
        const fullChapterData = {
            ...chapterData,
            mangaId: mangaId,
            chapterGroup: chapterGroup,
            savedAt: Date.now(),
            status: 'pending_images'
        };
        
        // حفظ الفصل
        await writeToFirebase(chapterPath, fullChapterData);
        
        // **التعديل 4: تحديث الإحصائيات بعد الحفظ**
        this.currentGroupCount++;
        this.totalChaptersSaved++;
        
        await writeToFirebase('System/chapter_stats', {
            currentGroup: this.groupCounter,
            currentGroupCount: this.currentGroupCount,
            totalChapters: this.totalChaptersSaved,
            lastUpdate: Date.now()
        });
        
        // إنشاء المجموعة الرئيسية إذا لم تكن موجودة
        const groupBase = await readFromFirebase(chapterGroup);
        if (!groupBase || !groupBase.created) { // تحقق إضافي
            await writeToFirebase(chapterGroup, {
                created: Date.now(),
                type: 'chapter_group'
            });
        }
        
        console.log(`✅ تم حفظ الفصل في ${chapterGroup}/${mangaId}/chapters/${chapterId}`);
        
        // **التعديل 5: إرسال إشعار إلى البوت 3**
        try {
            const notifyUrl = `${SERVER_3_URL}/process-chapter/${mangaId}/${chapterId}?group=${chapterGroup}`;
            await axios.get(notifyUrl);
            console.log(`🔔 تم إرسال إشعار إلى البوت 3 لمعالجة الفصل: ${chapterId}`);
        } catch (error) {
            console.error(`❌ فشل إرسال إشعار إلى البوت 3: ${error.message}`);
        }
        
        return {
            saved: true,
            chapterId: chapterId,
            group: chapterGroup
        };
    }
}

const chapterGroupManager = new ChapterGroupManager();

// ==================== دوال مساعدة ====================
function generateSafeChapterId(chapterNumber) {
    return `ch_${chapterNumber.toString().replace(/[^\w]/g, '_')}`;
}

function cleanChapterNumber(chapterStr) {
    const match = chapterStr.match(/(\d+(\.\d+)?)/);
    return match ? parseFloat(match[1]) : 0;
}

function getRandomHeaders() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    ];
    // **التعديل 6: إضافة رأس Referer لتقليل الحظر**
    return { 
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'Referer': 'https://azoramoon.com/' 
    };
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

// ==================== استخراج الفصول ====================
function extractChapters(html) {
    const $ = cheerio.load(html);
    const chapters = [];
    const chapterSelectors = [
        '.wp-manga-chapter',
        '.chapter-item',
        '.listing-chapters_wrap a',
        'ul.main.version-chap li',
        '.chapter-list a',
        '.chapter-li a'
    ];
    
    for (const selector of chapterSelectors) {
        const elements = $(selector);
        if (elements.length > 0) {
            console.log(`✅ وجد ${elements.length} فصل باستخدام: ${selector}`);
            
            elements.each((i, element) => {
                const $el = $(element);
                const chapterLink = $el.find('a').attr('href') || $el.attr('href');
                const chapterTitle = $el.find('a').text().trim() || $el.text().trim();
                
                if (chapterLink && chapterTitle) {
                    const chapterNum = cleanChapterNumber(chapterTitle);
                    
                    chapters.push({
                        title: chapterTitle,
                        url: chapterLink,
                        chapterNumber: chapterNum,
                        safeChapterId: generateSafeChapterId(chapterNum),
                        scrapedAt: Date.now()
                    });
                }
            });
            // **التعديل 7: يجب التوقف بعد العثور على الفصول لتجنب التكرار**
            break; 
        }
    }
    
    // **التعديل 8: عكس ترتيب الفصول لضمان معالجة الأقدم أولاً**
    return chapters.reverse();
}

// ==================== منطق معالجة المانجا ====================
async function processManga(mangaId, groupName) {
    console.log(`\n🎯 بدء معالجة المانجا: ${mangaId} (${groupName})`);
    
    let mangaData = await readFromFirebase(`${groupName}/${mangaId}`);
    
    if (!mangaData) {
        throw new Error(`المانجا ${mangaId} غير موجودة في ${groupName}`);
    }
    
    const url = mangaData.url;
    
    // **التعديل 9: تحديث الحالة إلى قيد المعالجة**
    await writeToFirebase(`${groupName}/${mangaId}`, {
        ...mangaData,
        status: 'processing',
        processingStarted: Date.now()
    });
    
    try {
        const html = await fetchWithRetry(url);
        const scrapedChapters = extractChapters(html);
        
        if (scrapedChapters.length === 0) {
            throw new Error('لم يتم العثور على أي فصول');
        }
        
        let newChaptersCount = 0;
        
        for (const chapter of scrapedChapters) {
            const chapterId = chapter.safeChapterId;
            
            // التحقق مما إذا كان الفصل موجودًا بالفعل
            const chapterGroup = await chapterGroupManager.getChapterGroup();
            const chapterPath = `${chapterGroup}/${mangaId}/chapters/${chapterId}`;
            const existingChapter = await readFromFirebase(chapterPath);
            
            if (!existingChapter) {
                // حفظ الفصل وإرسال إشعار إلى البوت 3
                await chapterGroupManager.saveChapter(mangaId, chapter);
                newChaptersCount++;
                await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_CHAPTERS));
            } else {
                console.log(`⏭️  الفصل ${chapter.title} موجود بالفعل. تم التخطي.`);
            }
        }
        
        // تحديث حالة المانجا في البوت 1
        await writeToFirebase(`${groupName}/${mangaId}`, {
            ...mangaData,
            status: 'chapters_added',
            lastChecked: Date.now(),
            newChapters: newChaptersCount,
            totalChapters: (mangaData.totalChapters || 0) + newChaptersCount
        });
        
        console.log(`✅ اكتملت معالجة المانجا ${mangaId}. تم إضافة ${newChaptersCount} فصل جديد.`);
        
        return {
            success: true,
            newChapters: newChaptersCount
        };
        
    } catch (error) {
        console.error(`❌ خطأ في معالجة المانجا ${mangaId}:`, error.message);
        
        // تحديث حالة المانجا إلى خطأ
        await writeToFirebase(`${groupName}/${mangaId}`, {
            ...mangaData,
            status: 'error',
            error: error.message,
            lastChecked: Date.now()
        });
        
        return {
            success: false,
            error: error.message
        };
    }
}

// **التعديل 10: إزالة محرك الفحص المستمر غير الضروري**
/*
async function continuousMangaCheck() {
    // ... (تمت إزالة الكود)
}
*/

// ==================== واجهات API ====================
const app = express();

// **التعديل 11: تعديل واجهة API لاستقبال الطلب من البوت 1**
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
        
        // **التعديل 12: تشغيل العملية في الخلفية لتجنب انتهاء مهلة الطلب**
        processManga(mangaId, group)
            .then(result => console.log(`[خلفية] معالجة المانجا ${mangaId} اكتملت:`, result))
            .catch(error => console.error(`[خلفية] خطأ في معالجة المانجا ${mangaId}:`, error.message));
        
        res.json({ 
            success: true, 
            message: 'بدأت معالجة الفصول في الخلفية',
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

// **التعديل 13: إزالة واجهة API /force-create-imgchapter غير الضرورية**
// app.get('/force-create-imgchapter', async (req, res) => { ... });

// **التعديل 14: إزالة واجهة API /test-chapter/:mangaId غير الضرورية**
// app.get('/test-chapter/:mangaId', async (req, res) => { ... });

app.get('/stats', async (req, res) => {
    try {
        const chapterStats = await readFromFirebase('System/chapter_stats') || {};
        
        // **التعديل 15: تبسيط حساب الإحصائيات (يمكن إعادة تفعيل الحساب المعقد إذا لزم الأمر)**
        // تم إزالة الحساب المعقد الذي يقرأ جميع المجموعات لتجنب انتهاء المهلة
        
        res.json({
            success: true,
            system: SYSTEM_CONFIG,
            chapterStats: chapterStats,
            totals: {
                totalChaptersSaved: chapterStats.totalChapters || 0,
                chapterGroups: chapterStats.currentGroup || 1
            },
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
        <p><strong>الحالة:</strong> 🟢 يعمل وينتظر أوامر من البوت 1</p>
        <p><strong>المجموعات:</strong> ${SYSTEM_CONFIG.GROUP_PREFIX}_1 إلى N</p>
        <p><strong>الفصول/مجموعة:</strong> ${SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP}</p>
        
        <h3>الروابط:</h3>
        <p><a href="/stats">/stats</a> - إحصائيات الفصول</p>
    `);
});

app.listen(PORT, () => {
    console.log(`\n✅ البوت 2 يعمل على المنفذ ${PORT}`);
    console.log(`📊 نظام الفصول:`);
    console.log(`   • المجموعات: ${SYSTEM_CONFIG.GROUP_PREFIX}_1 إلى N`);
    console.log(`   • الفصول/مجموعة: ${SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP}`);
    
    setTimeout(async () => {
        await chapterGroupManager.initialize();
        // **التعديل 16: إزالة بدء الفحص المستمر**
        // continuousMangaCheck();
        console.log('⏸️ تم تعطيل الفحص المستمر. البوت ينتظر الآن إشارات من البوت 1.');
    }, 5000);
});
