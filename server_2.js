const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

// دالة للقراءة من Firebase
async function readFromFirebase(path) {
    const url = `${DATABASE_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('❌ خطأ في القراءة من Firebase:', error.message);
        return null;
    }
}

// دالة للكتابة إلى Firebase
async function writeToFirebase(path, data) {
    const url = `${DATABASE_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        const response = await axios.put(url, data);
        return response.data;
    } catch (error) {
        console.error('❌ خطأ في الكتابة إلى Firebase:', error.message);
        throw error;
    }
}

// دالة لجلب جميع الفصول من صفحة المانجا
async function scrapeChapters(mangaUrl, mangaId) {
    try {
        console.log(`📥 جلب الفصول من: ${mangaUrl}`);
        
        const response = await axios.get(mangaUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive'
            }
        });
        
        const $ = cheerio.load(response.data);
        
        // استخراج العنوان
        const mangaTitle = $('.post-title h1').text().trim();
        console.log(`📖 مانجا: ${mangaTitle}`);
        
        // استخراج جميع الفصول (الظاهرة والمخفية)
        const chapters = [];
        
        $('.wp-manga-chapter').each((i, element) => {
            const $el = $(element);
            const chapterLink = $el.find('a').attr('href');
            const chapterTitle = $el.find('a').text().trim();
            
            if (chapterLink && chapterTitle) {
                // استخراج رقم الفصل
                const chapterNumMatch = chapterTitle.match(/(\d+)/);
                const chapterNum = chapterNumMatch ? parseInt(chapterNumMatch[1]) : i + 1;
                
                chapters.push({
                    chapterId: `ch_${chapterNum.toString().padStart(3, '0')}`,
                    chapterNumber: chapterNum,
                    title: chapterTitle,
                    url: chapterLink,
                    status: 'pending_images',
                    test: chapterLink, // رابط للبوت الثالث
                    createdAt: Date.now()
                });
            }
        });
        
        console.log(`✅ تم العثور على ${chapters.length} فصل`);
        
        return { 
            mangaTitle, 
            chapters: chapters.sort((a, b) => a.chapterNumber - b.chapterNumber) 
        };
        
    } catch (error) {
        console.error('❌ خطأ في جلب الفصول:', error.message);
        return { mangaTitle: '', chapters: [] };
    }
}

// دالة للبحث عن مهام جديدة
async function checkForNewJobs() {
    try {
        console.log('🔍 البحث عن مهام جديدة...');
        
        // قراءة جميع المهام
        const jobs = await readFromFirebase('Jobs');
        
        if (!jobs) return null;
        
        // البحث عن أول مهمة بانتظار المعالجة
        for (const [mangaId, job] of Object.entries(jobs)) {
            if (job && job.status === 'waiting') {
                return { mangaId, job };
            }
        }
        
        return null;
        
    } catch (error) {
        console.error('❌ خطأ في البحث عن مهام:', error.message);
        return null;
    }
}

// API لمعالجة المهمة التالية
app.get('/process-next', async (req, res) => {
    try {
        console.log('🚀 بدء معالجة المهمة التالية...');
        
        // البحث عن مهمة
        const jobData = await checkForNewJobs();
        
        if (!jobData) {
            return res.json({ 
                success: false, 
                message: 'لا توجد مهام في الانتظار' 
            });
        }
        
        const { mangaId, job } = jobData;
        
        console.log(`🎯 معالجة: ${mangaId}`);
        
        // تغيير حالة المهمة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'processing',
            startedAt: Date.now()
        });
        
        // جلب الفصول
        const { mangaTitle, chapters } = await scrapeChapters(job.mangaUrl, mangaId);
        
        if (chapters.length === 0) {
            await writeToFirebase(`Jobs/${mangaId}`, {
                ...job,
                status: 'failed',
                error: 'لم يتم العثور على فصول',
                completedAt: Date.now()
            });
            
            return res.json({ 
                success: false, 
                message: 'لم يتم العثور على فصول' 
            });
        }
        
        // تحديث معلومات المانجا
        await writeToFirebase(`HomeManga/${mangaId}`, {
            title: mangaTitle,
            totalChapters: chapters.length,
            status: 'chapters_ready',
            chaptersUpdatedAt: Date.now()
        });
        
        // حفظ الفصول
        for (const chapter of chapters) {
            await writeToFirebase(`ImgChapter/${mangaId}/${chapter.chapterId}`, {
                ...chapter,
                mangaId: mangaId,
                mangaTitle: mangaTitle
            });
            
            console.log(`📝 تم حفظ: ${chapter.title}`);
        }
        
        // تحديث حالة المهمة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'completed',
            chaptersCount: chapters.length,
            completedAt: Date.now()
        });
        
        console.log(`✅ تم معالجة ${chapters.length} فصل`);
        
        res.json({
            success: true,
            message: `تم معالجة ${chapters.length} فصل`,
            mangaId,
            chaptersCount: chapters.length
        });
        
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// معالجة تلقائية كل دقيقة
setInterval(async () => {
    console.log('⏰ فحص تلقائي للمهام...');
    await checkForNewJobs();
}, 60000);

// صفحة الاختبار
app.get('/', (req, res) => {
    res.send(`
        <h1>✅ البوت 2 يعمل</h1>
        <p>استخدم <a href="/process-next">/process-next</a> لمعالجة المهمة التالية</p>
        <p>Firebase: ${DATABASE_SECRETS ? '✅ متصل' : '❌ غير متصل'}</p>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`✅ البوت 2 يعمل على المنفذ ${PORT}`);
    console.log(`🔗 استخدم /process-next لبدء المعالجة`);
});
