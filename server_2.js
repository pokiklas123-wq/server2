const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;
const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// 🔧 الدوال الأساسية
async function writeToFirebase(path, data) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        await axios.put(url, data, { timeout: 5000 });
        return true;
    } catch (error) {
        console.error(`❌ كتابة: ${error.message}`);
        return false;
    }
}

async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        const response = await axios.get(url, { timeout: 5000 });
        return response.data;
    } catch (error) {
        return null;
    }
}

// 📖 استخراج الفصول
async function extractChapters(mangaUrl) {
    try {
        console.log(`📚 جلب فصول: ${mangaUrl}`);
        
        const response = await axios.get(mangaUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000
        });
        
        const $ = cheerio.load(response.data);
        const chapters = [];
        
        $('.wp-manga-chapter').each((i, element) => {
            const $el = $(element);
            const chapterLink = $el.find('a').attr('href');
            const chapterTitle = $el.find('a').text().trim();
            
            if (chapterLink && chapterTitle) {
                const chapterNumMatch = chapterTitle.match(/(\d+)/);
                const chapterNum = chapterNumMatch ? parseInt(chapterNumMatch[1]) : i + 1;
                
                chapters.push({
                    chapterId: `ch_${chapterNum.toString().padStart(4, '0')}`,
                    chapterNumber: chapterNum,
                    title: chapterTitle,
                    url: chapterLink.startsWith('http') ? chapterLink : `https://azoramoon.com${chapterLink}`,
                    status: 'pending_images',
                    createdAt: Date.now()
                });
            }
        });
        
        console.log(`📊 وجدت ${chapters.length} فصل`);
        return chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        
    } catch (error) {
        console.error(`❌ خطأ في الفصول: ${error.message}`);
        return [];
    }
}

// 🔄 المعالجة التلقائية
async function autoProcessJobs() {
    console.log('\n🔍 البحث عن مهام...');
    
    try {
        // 1. البحث عن مهام جديدة
        const jobs = await readFromFirebase('Jobs');
        if (!jobs) return;
        
        for (const [mangaId, job] of Object.entries(jobs)) {
            if (job.status === 'waiting') {
                console.log(`🎯 معالجة: ${mangaId}`);
                
                // تحديث الحالة
                await writeToFirebase(`Jobs/${mangaId}`, {
                    ...job,
                    status: 'processing',
                    startedAt: Date.now()
                });
                
                // استخراج الفصول
                const chapters = await extractChapters(job.mangaUrl);
                
                if (chapters.length > 0) {
                    // حفظ الفصول
                    for (const chapter of chapters) {
                        await writeToFirebase(`ImgChapter/${mangaId}/${chapter.chapterId}`, chapter);
                    }
                    
                    // تحديث المانجا
                    await writeToFirebase(`HomeManga/${mangaId}`, {
                        totalChapters: chapters.length,
                        status: 'chapters_ready',
                        chaptersUpdatedAt: Date.now()
                    });
                    
                    // إكمال المهمة
                    await writeToFirebase(`Jobs/${mangaId}`, {
                        ...job,
                        status: 'completed',
                        chaptersCount: chapters.length,
                        completedAt: Date.now()
                    });
                    
                    console.log(`✅ تم: ${chapters.length} فصل`);
                    
                } else {
                    await writeToFirebase(`Jobs/${mangaId}`, {
                        ...job,
                        status: 'failed',
                        error: 'لم يتم العثور على فصول',
                        completedAt: Date.now()
                    });
                    console.log(`❌ فشل: لا توجد فصول`);
                }
                
                // تأخير بين المهام
                await new Promise(resolve => setTimeout(resolve, 2000));
                break; // مهمة واحدة في كل دورة
            }
        }
        
        // 2. التحقق من تحديثات الفصول
        const allManga = await readFromFirebase('HomeManga') || {};
        
        for (const [mangaId, manga] of Object.entries(allManga)) {
            if (manga.needsChapterCheck) {
                console.log(`🔍 فحص تحديثات لـ ${mangaId}`);
                
                // قراءة الفصول الحالية
                const currentChapters = await readFromFirebase(`ImgChapter/${mangaId}`) || {};
                const currentCount = Object.keys(currentChapters).length;
                
                // جلب الفصول الجديدة
                const job = await readFromFirebase(`Jobs/${mangaId}`);
                if (job && job.mangaUrl) {
                    const newChapters = await extractChapters(job.mangaUrl);
                    
                    if (newChapters.length > currentCount) {
                        console.log(`🆕 فصول جديدة: ${newChapters.length - currentCount}`);
                        
                        // إضافة الفصول الجديدة فقط
                        for (const chapter of newChapters) {
                            if (!currentChapters[chapter.chapterId]) {
                                await writeToFirebase(`ImgChapter/${mangaId}/${chapter.chapterId}`, chapter);
                                console.log(`➕ فصل جديد: ${chapter.chapterId}`);
                            }
                        }
                    }
                }
                
                // إزالة العلامة
                await writeToFirebase(`HomeManga/${mangaId}/needsChapterCheck`, null);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
    } catch (error) {
        console.error('❌ خطأ في المعالجة:', error.message);
    }
}

// ⏰ تشغيل تلقائي كل دقيقة
let autoProcessInterval = null;

function startAutoProcess(intervalSeconds = 60) {
    if (autoProcessInterval) clearInterval(autoProcessInterval);
    
    autoProcessInterval = setInterval(autoProcessJobs, intervalSeconds * 1000);
    console.log(`⏰ بدأ المعالجة كل ${intervalSeconds} ثانية`);
    
    // تشغيل أول مرة
    setTimeout(autoProcessJobs, 3000);
}

function stopAutoProcess() {
    if (autoProcessInterval) {
        clearInterval(autoProcessInterval);
        autoProcessInterval = null;
        console.log('⏹️ توقف المعالجة');
    }
}

// 📊 APIs
app.get('/start', (req, res) => {
    const interval = parseInt(req.query.seconds) || 60;
    startAutoProcess(interval);
    res.json({ success: true, message: `بدأت المعالجة كل ${interval} ثانية` });
});

app.get('/stop', (req, res) => {
    stopAutoProcess();
    res.json({ success: true, message: 'توقفت المعالجة' });
});

app.get('/run-now', async (req, res) => {
    await autoProcessJobs();
    res.json({ success: true, message: 'تمت المعالجة الآن' });
});

app.get('/status', async (req, res) => {
    const jobs = await readFromFirebase('Jobs') || {};
    const pending = Object.values(jobs).filter(j => j.status === 'waiting').length;
    const processing = Object.values(jobs).filter(j => j.status === 'processing').length;
    const completed = Object.values(jobs).filter(j => j.status === 'completed').length;
    
    res.json({
        success: true,
        autoRunning: !!autoProcessInterval,
        jobs: { pending, processing, completed, total: Object.keys(jobs).length }
    });
});

// 🏠 صفحة بسيطة
app.get('/', (req, res) => {
    res.send(`
        <h1>📖 البوت 2 - معالج الفصول</h1>
        <p><a href="/start">/start</a> - بدء التلقائي (60 ثانية)</p>
        <p><a href="/stop">/stop</a> - إيقاف التلقائي</p>
        <p><a href="/run-now">/run-now</a> - تشغيل الآن</p>
        <p><a href="/status">/status</a> - حالة النظام</p>
    `);
});

// 🚀 التشغيل
app.listen(PORT, () => {
    console.log(`✅ البوت 2 يعمل على ${PORT}`);
    startAutoProcess(60);
});
