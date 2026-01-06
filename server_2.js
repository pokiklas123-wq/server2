const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

// ==================== متغيرات البيئة ====================
const PORT = process.env.PORT || 3001;
const DATABASE_SECRETS = "KXPNxnGZDA1BGnzs4kZIA45o6Vr9P5nJ3Z01X4bt";
const DATABASE_URL = "https://hackerdz-b1bdf.firebaseio.com";
const SERVER_3_URL = process.env.SERVER_3_URL || 'http://localhost:3002';

// ==================== إعدادات النظام ====================
const SYSTEM_CONFIG = {
    MAX_CHAPTERS_PER_GROUP: 300,
    CHAPTER_GROUP_PREFIX: 'ImgChapter',
    DELAY_BETWEEN_CHAPTERS: 2000,
    DELAY_BETWEEN_MANGA: 3000,
    DELAY_BETWEEN_GROUPS: 2000,
    MAX_FETCH_RETRIES: 3,
    MAX_MANGA_PER_CYCLE: 20
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
    
    async getChapterGroupForManga(mangaId) {
        const stats = await readFromFirebase('System/chapter_stats') || {
            currentGroup: 1,
            currentGroupCount: 0,
            totalChapters: 0
        };
        
        this.groupCounter = stats.currentGroup || 1;
        this.currentGroupCount = stats.currentGroupCount || 0;
        this.totalChaptersSaved = stats.totalChapters || 0;
        
        if (this.currentGroupCount >= SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP) {
            this.groupCounter++;
            this.currentGroupCount = 0;
            console.log(`🔄 الانتقال إلى مجموعة الفصول ${this.groupCounter}`);
        }
        
        const chapterGroup = `${SYSTEM_CONFIG.CHAPTER_GROUP_PREFIX}_${this.groupCounter}`;
        
        this.currentGroupCount++;
        this.totalChaptersSaved++;
        
        await writeToFirebase('System/chapter_stats', {
            currentGroup: this.groupCounter,
            currentGroupCount: this.currentGroupCount,
            totalChapters: this.totalChaptersSaved,
            lastUpdate: Date.now()
        });
        
        return chapterGroup;
    }
    
    async saveChapterToGroup(mangaId, chapterData) {
        const chapterGroup = await this.getChapterGroupForManga(mangaId);
        const chapterId = chapterData.safeChapterId || `ch_${chapterData.chapterNumber.toString().replace(/[^\w]/g, '_')}`;
        const path = `${chapterGroup}/${mangaId}/chapters/${chapterId}`;
        
        const fullChapterData = {
            ...chapterData,
            mangaId: mangaId,
            chapterGroup: chapterGroup,
            savedAt: Date.now()
        };
        
        await writeToFirebase(path, fullChapterData);
        
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
    return { 'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)] };
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
        '.chapter-list a'
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
                    const safeChapterId = generateSafeChapterId(chapterNum || i + 1);
                    
                    chapters.push({
                        chapterId: safeChapterId,
                        chapterNumber: chapterNum || i + 1,
                        title: chapterTitle,
                        url: chapterLink.startsWith('http') ? chapterLink : `https://azoramoon.com${chapterLink}`,
                        status: 'pending_images',
                        createdAt: Date.now(),
                        safeChapterId: safeChapterId
                    });
                }
            });
            return chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        }
    }
    
    console.log('⚠️ لم يتم العثور على فصول باستخدام أي من المحددات');
    return [];
}

// ==================== جلب الفصول من URL ====================
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

// ==================== معالجة المانجا ====================
async function processManga(mangaId, groupName) {
    console.log(`\n🎯 بدء معالجة المانجا: ${mangaId} (${groupName})`);
    
    try {
        const mangaData = await readFromFirebase(`${groupName}/${mangaId}`);
        
        if (!mangaData) {
            console.error(`❌ المانجا ${mangaId} غير موجودة في ${groupName}`);
            return { success: false, message: 'المانجا غير موجودة' };
        }
        
        console.log(`📖 المانجا: ${mangaData.title || mangaId}`);
        console.log(`🔗 الرابط: ${mangaData.url}`);
        
        const scrapedChapters = await getChaptersFromUrl(mangaData.url);
        
        if (scrapedChapters.length === 0) {
            console.log('⚠️ لم يتم العثور على أي فصول.');
            
            await writeToFirebase(`${groupName}/${mangaId}`, {
                ...mangaData,
                status: 'no_chapters_found',
                lastChecked: Date.now(),
                chaptersCount: 0
            });
            
            return { success: false, message: 'لم يتم العثور على أي فصول' };
        }
        
        console.log(`📊 تم العثور على ${scrapedChapters.length} فصل`);
        
        let newChaptersCount = 0;
        let savedChapters = [];
        
        for (const chapter of scrapedChapters) {
            let chapterExists = false;
            
            const stats = await readFromFirebase('System/chapter_stats') || {};
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
                const result = await chapterGroupManager.saveChapterToGroup(mangaId, chapter);
                
                if (result.saved) {
                    newChaptersCount++;
                    savedChapters.push(chapter);
                    
                    console.log(`✨ فصل جديد: ${chapter.title}`);
                    
                    await notifyServer3(mangaId, chapter, result.group);
                    
                    await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_CHAPTERS));
                }
            }
        }
        
        const status = newChaptersCount > 0 ? 'chapters_added' : 'up_to_date';
        
        await writeToFirebase(`${groupName}/${mangaId}`, {
            ...mangaData,
            status: status,
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
            newChapters: newChaptersCount
        };
        
    } catch (error) {
        console.error(`❌ خطأ في معالجة المانجا ${mangaId}:`, error.message);
        
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

// ==================== محرك الفحص المستمر ====================
async function continuousMangaCheck() {
    console.log('\n🔍 بدء الفحص المستمر للمانجا...');
    
    while (true) {
        try {
            let processedCount = 0;
            let newChaptersTotal = 0;
            
            console.log('\n📊 بدء دورة فحص جديدة...');
            
            for (let groupNum = 1; groupNum <= 52; groupNum++) {
                const groupName = `HomeManga_${groupNum}`;
                
                try {
                    console.log(`\n📁 فحص المجموعة: ${groupName}`);
                    
                    const groupData = await readFromFirebase(groupName);
                    
                    if (!groupData || typeof groupData !== 'object') {
                        console.log(`   ⏭️  المجموعة فارغة أو غير موجودة`);
                        continue;
                    }
                    
                    const mangaIds = Object.keys(groupData);
                    console.log(`   📊 عدد المانجا: ${mangaIds.length}`);
                    
                    if (mangaIds.length === 0) {
                        continue;
                    }
                    
                    for (const mangaId of mangaIds) {
                        const manga = groupData[mangaId];
                        
                        if (!manga) continue;
                        
                        const needsProcessing = 
                            manga.status === 'pending_chapters' ||
                            manga.status === 'chapters_added' ||
                            manga.status === 'error' ||
                            !manga.status ||
                            (manga.lastChecked && (Date.now() - manga.lastChecked) > 86400000);
                        
                        if (needsProcessing) {
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
                                console.log(`\n⏸️  وصلت للحد الأقصى (${SYSTEM_CONFIG.MAX_MANGA_PER_CYCLE}) في هذه الدورة`);
                                break;
                            }
                        }
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_GROUPS));
                    
                    if (processedCount >= SYSTEM_CONFIG.MAX_MANGA_PER_CYCLE) {
                        break;
                    }
                    
                } catch (groupError) {
                    console.error(`   ❌ خطأ في المجموعة ${groupName}:`, groupError.message);
                }
            }
            
            console.log(`\n📊 دورة الفحص اكتملت:`);
            console.log(`   • مانجا معالجة: ${processedCount}`);
            console.log(`   • فصول جديدة: ${newChaptersTotal}`);
            
            const waitTime = processedCount > 0 ? 120000 : 300000;
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

app.get('/force-scan/:groupNum', async (req, res) => {
    const { groupNum } = req.params;
    const groupName = `HomeManga_${groupNum}`;
    
    try {
        console.log(`🚀 بدء فحص قسري للمجموعة ${groupName}`);
        
        const groupData = await readFromFirebase(groupName);
        
        if (!groupData) {
            return res.json({ 
                success: false, 
                message: `المجموعة ${groupName} غير موجودة` 
            });
        }
        
        const mangaIds = Object.keys(groupData);
        let processed = 0;
        
        for (const mangaId of mangaIds) {
            await processManga(mangaId, groupName);
            processed++;
            
            if (processed >= 5) break; // 5 مانجا فقط للاختبار
        }
        
        res.json({ 
            success: true, 
            message: `تم معالجة ${processed} مانجا من ${groupName}`,
            processed: processed,
            total: mangaIds.length
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
        
        let totalChapters = 0;
        let mangaWithChapters = 0;
        
        for (let g = 1; g <= (chapterStats.currentGroup || 1); g++) {
            const groupName = `ImgChapter_${g}`;
            const groupData = await readFromFirebase(groupName);
            
            if (groupData) {
                for (const mangaId in groupData) {
                    if (groupData[mangaId] && groupData[mangaId].chapters) {
                        mangaWithChapters++;
                        totalChapters += Object.keys(groupData[mangaId].chapters).length;
                    }
                }
            }
        }
        
        res.json({
            success: true,
            system: SYSTEM_CONFIG,
            chapterStats: chapterStats,
            totals: {
                totalChapters: totalChapters,
                mangaWithChapters: mangaWithChapters,
                chapterGroups: chapterStats.currentGroup || 1
            },
            groups: Array.from({length: chapterStats.currentGroup || 1}, (_, i) => 
                `ImgChapter_${i + 1}`
            )
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <h1>📖 البوت 2 - معالج الفصول (النسخة النشطة)</h1>
        <p><strong>الحالة:</strong> 🟢 يعمل ويبحث في جميع المجموعات</p>
        <p><strong>المجموعات:</strong> HomeManga_1 إلى HomeManga_52</p>
        <p><strong>الفصول/مجموعة:</strong> ${SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP}</p>
        <p><strong>الحد/دورة:</strong> ${SYSTEM_CONFIG.MAX_MANGA_PER_CYCLE} مانجا</p>
        
        <h3>الروابط:</h3>
        <p><a href="/stats">/stats</a> - إحصائيات الفصول</p>
        <p><a href="/force-scan/1">/force-scan/1</a> - فحص قسري للمجموعة 1</p>
        
        <h3>هيكل التخزين:</h3>
        <pre>ImgChapter_1/
└── [manga_id]/
    └── chapters/
        ├── ch_1
        ├── ch_2
        └── ...

ImgChapter_2/
└── [manga_id]/
    └── chapters/
        ├── ch_301
        └── ...</pre>
    `);
});

app.listen(PORT, () => {
    console.log(`\n✅ البوت 2 يعمل على المنفذ ${PORT}`);
    console.log(`📊 نظام الفصول:`);
    console.log(`   • المجموعات: HomeManga_1 إلى HomeManga_52`);
    console.log(`   • الفصول/مجموعة: ${SYSTEM_CONFIG.MAX_CHAPTERS_PER_GROUP}`);
    console.log(`   • الحد/دورة: ${SYSTEM_CONFIG.MAX_MANGA_PER_CYCLE} مانجا`);
    
    setTimeout(() => {
        continuousMangaCheck();
    }, 5000);
});
