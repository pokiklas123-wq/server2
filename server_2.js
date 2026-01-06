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

// ==================== رؤوس HTTP محسنة ====================
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

const REFERERS = [
    'https://www.google.com/',
    'https://www.bing.com/',
    'https://azoramoon.com/',
    ''
];

const PROXIES = [
    '',
    'https://cors-anywhere.herokuapp.com/',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://proxy.cors.sh/'
];

// ==================== دوال الرؤوس ====================
function getRandomHeaders() {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const referer = REFERERS[Math.floor(Math.random() * REFERERS.length)];
    
    return {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Referer': referer,
        'DNT': '1'
    };
}

async function tryAllProxies(url) {
    const errors = [];
    
    for (const proxy of PROXIES) {
        try {
            let targetUrl = url;
            if (proxy) {
                targetUrl = proxy + encodeURIComponent(url);
            }
            
            console.log(`🔄 محاولة [${proxy ? 'بروكسي' : 'مباشر'}]`);
            
            const response = await axios.get(targetUrl, {
                headers: getRandomHeaders(),
                timeout: 20000,
                maxRedirects: 3,
                validateStatus: (status) => status >= 200 && status < 500
            });
            
            if (response.status === 200) {
                console.log(`✅ نجح [${proxy ? 'بروكسي' : 'مباشر'}]`);
                return response.data;
            } else {
                errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${response.status}`);
            }
            
        } catch (error) {
            errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${error.message}`);
            console.log(`❌ فشل [${proxy ? 'بروكسي' : 'مباشر'}]: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`فشلت جميع محاولات الجلب:\n${errors.join('\n')}`);
}

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
            // **التعديل 19: استخدام تأخير عشوائي لمحاكاة سلوك الإنسان**
            const randomDelay = 2000 + Math.floor(Math.random() * 3000); // بين 2 و 5 ثواني
            console.log(`   ⏳ فشل الطلب (${i + 1}/${maxRetries}). الانتظار ${randomDelay / 1000} ثانية...`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));
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
        // **التعديل 20: استخدام tryAllProxies بدلاً من fetchWithRetry**
        const html = await tryAllProxies(url);
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
                // استخدام تأخير عشوائي بين حفظ الفصول
                const randomDelay = SYSTEM_CONFIG.DELAY_BETWEEN_CHAPTERS + Math.floor(Math.random() * 1000);
                await new Promise(resolve => setTimeout(resolve, randomDelay));
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

// ==================== محرك الفحص المستمر ====================
async function continuousMangaCheck() {
    console.log('\n🔍 بدء الفحص المستمر للمانجا...');
    
    while (true) {
        try {
            let processedCount = 0;
            let newChaptersTotal = 0;
            
            console.log('\n📊 بدء دورة فحص جديدة للمانجا...');
            
            // **التعديل 17: تحسين منطق الفحص المستمر للبوت 2**
            // قراءة إحصائيات المانجا من البوت 1
            const mangaStats = await readFromFirebase('System/stats') || {};
            const maxGroup = mangaStats.currentGroup || 1;
            
            console.log(`📁 عدد مجموعات المانجا المحتملة: ${maxGroup}`);
            
            for (let groupNum = 1; groupNum <= maxGroup; groupNum++) {
                const groupName = `${SYSTEM_CONFIG.GROUP_PREFIX}_${groupNum}`;
                
                try {
                    console.log(`\n📁 فحص مجموعة المانجا: ${groupName}`);
                    
                    const groupData = await readFromFirebase(groupName);
                    
                    if (!groupData || typeof groupData !== 'object') {
                        console.log(`   ⏭️  المجموعة فارغة أو غير موجودة (Group Data: ${JSON.stringify(groupData)})`);
                        continue;
                    }
                    
                    const mangaIds = Object.keys(groupData).filter(key => key !== 'created' && key !== 'type');
                    console.log(`   📊 تم العثور على ${mangaIds.length} عنصر في المجموعة.`);
                    
                    for (const mangaId of mangaIds) {
                        const manga = groupData[mangaId];
                        
                        // **التعديل 18: إضافة تسجيل مفصل لحالة المانجا**
                        console.log(`   🔍 فحص المانجا ${mangaId} - الحالة الحالية: ${manga.status || 'غير محدد'}`);
                        
                        // معالجة المانجا التي لم يتم معالجتها بعد أو التي بها خطأ
                        if (manga.status === 'pending_chapters' || 
                            manga.status === 'error' || 
                            !manga.status) {
                            
                            console.log(`\n🎯 معالجة [${groupName}]: ${manga.title || mangaId}`);
                            console.log(`   📊 الحالة: ${manga.status || 'unknown'}`);
                            
                            try {
                                const result = await processManga(mangaId, groupName);
                                
                                if (result.success) {
                                    processedCount++;
                                    newChaptersTotal += result.newChapters || 0;
                                    
                                    console.log(`   ✅ تمت المعالجة: ${result.newChapters || 0} فصل جديد`);
                                } else {
                                    console.log(`   ⚠️  فشل: ${result.message || result.error}`);
                                }
                                
                            } catch (error) {
                                console.error(`   ❌ خطأ في المعالجة: ${error.message}`);
                            }
                            
                            await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_MANGA));
                            
                            if (processedCount >= SYSTEM_CONFIG.MAX_MANGA_PER_CYCLE) {
                                console.log(`\n⏸️  وصلت للحد الأقصى (${SYSTEM_CONFIG.MAX_MANGA_PER_CYCLE})`);
                                break;
                            }
                        }
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_GROUPS));
                    
                    if (processedCount >= SYSTEM_CONFIG.MAX_MANGA_PER_CYCLE) break;
                    
                } catch (groupError) {
                    console.error(`   ❌ خطأ في المجموعة ${groupName}:`, groupError.message);
                }
            }
            
            console.log(`\n📊 دورة الفحص اكتملت:`);
            console.log(`   • مانجا معالجة: ${processedCount}`);
            console.log(`   • فصول جديدة: ${newChaptersTotal}`);
            
            const waitTime = processedCount > 0 ? 120000 : 300000; // الانتظار دقيقتين إذا تمت المعالجة، 5 دقائق إذا لم تتم
            console.log(`⏳ الانتظار ${waitTime / 1000} ثانية للدورة التالية...\n`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
        } catch (error) {
            console.error('❌ خطأ في محرك الفحص المستمر:', error.message);
            await new Promise(resolve => setTimeout(resolve, 60000));
        }
    }
}

// ==================== واجهات API ====================
const app = express();

// **التعديل 11: تعديل واجهة API لاستقبال الطلب من البوت 1**
app.get('/process-manga/:mangaId', async (req, res) => {
    const { mangaId } = req.params;
    
    try {
        // البحث عن المانجا في جميع المجموعات
        const searchResult = await findMangaInGroups(mangaId);
        const groupName = searchResult.group;
        
        // **التعديل 12: تشغيل العملية في الخلفية لتجنب انتهاء مهلة الطلب**
        processManga(mangaId, groupName)
            .then(result => console.log(`[خلفية] معالجة المانجا ${mangaId} اكتملت:`, result))
            .catch(error => console.error(`[خلفية] خطأ في معالجة المانجا ${mangaId}:`, error.message));
        
        res.json({ 
            success: true, 
            message: 'بدأت معالجة الفصول في الخلفية',
            mangaId: mangaId,
            group: groupName
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
        
        // **التعديل 15: تبسيط حساب الإحصائيات**
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
        <p><strong>الحالة:</strong> 🟢 يعمل (مستمع للبوت 1 + فحص مستمر)</p>
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
    console.log(`   • رؤوس HTTP: ${USER_AGENTS.length} user agents`);
    console.log(`   • بروكسيات: ${PROXIES.length} خيارات`);
    
    setTimeout(async () => {
        // **التعديل 16: إعادة تفعيل بدء الفحص المستمر كخيار احتياطي**
        await chapterGroupManager.initialize(); 
        continuousMangaCheck();
        console.log('✅ تم تفعيل الفحص المستمر كخيار احتياطي.');
    }, 5000);
});
