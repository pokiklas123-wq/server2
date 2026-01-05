const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// دالة قراءة Firebase
async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        console.log(`📖 قراءة: ${path}`);
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
    } catch (error) {
        console.error(`❌ خطأ في قراءة ${path}:`, error.message);
        return null;
    }
}

// دالة كتابة Firebase
async function writeToFirebase(path, data) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        const response = await axios.put(url, data, { timeout: 10000 });
        console.log(`✅ كتب إلى ${path}`);
        return response.data;
    } catch (error) {
        console.error(`❌ خطأ في الكتابة إلى ${path}:`, error.message);
        return null;
    }
}

// دالة لجلب الفصول من الموقع
async function getChaptersFromSite(mangaUrl) {
    try {
        console.log(`🌐 جلب الفصول من: ${mangaUrl}`);
        
        const response = await axios.get(mangaUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        
        // استخراج العنوان
        const mangaTitle = $('.post-title h1').text().trim() || 'بدون عنوان';
        console.log(`📖 عنوان المانجا: ${mangaTitle}`);
        
        // البحث عن الفصول
        const chapters = [];
        
        // محاولة العثور على الفصول المخفية
        const allLinks = $('a[href*="/series/"]');
        console.log(`🔗 عدد الروابط: ${allLinks.length}`);
        
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
                    url: chapterLink.startsWith('http') ? chapterLink : `https://azoramoon.com${chapterLink}`,
                    status: 'pending_images',
                    test: chapterLink.startsWith('http') ? chapterLink : `https://azoramoon.com${chapterLink}`,
                    createdAt: Date.now()
                });
                
                console.log(`📝 ${chapterNum}. ${chapterTitle}`);
            }
        });
        
        console.log(`✅ تم العثور على ${chapters.length} فصل`);
        
        return {
            success: true,
            mangaTitle: mangaTitle,
            chapters: chapters,
            total: chapters.length
        };
        
    } catch (error) {
        console.error('❌ خطأ في جلب الفصول:', error.message);
        return {
            success: false,
            error: error.message,
            chapters: []
        };
    }
}

// API لمعالجة مهمة محددة
app.get('/process-manga/:mangaId', async (req, res) => {
    try {
        const { mangaId } = req.params;
        
        console.log(`\n🎯 معالجة المانجا: ${mangaId}`);
        
        // قراءة المهمة
        const job = await readFromFirebase(`Jobs/${mangaId}`);
        
        if (!job || !job.mangaUrl) {
            return res.json({
                success: false,
                error: 'لم يتم العثور على المهمة',
                mangaId: mangaId
            });
        }
        
        console.log(`🔗 الرابط: ${job.mangaUrl}`);
        
        // تحديث الحالة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'processing',
            startedAt: Date.now()
        });
        
        // جلب الفصول
        const result = await getChaptersFromSite(job.mangaUrl);
        
        if (!result.success || result.chapters.length === 0) {
            // تحديث بالفشل
            await writeToFirebase(`Jobs/${mangaId}`, {
                ...job,
                status: 'failed',
                error: result.error || 'لم يتم العثور على فصول',
                completedAt: Date.now()
            });
            
            return res.json({
                success: false,
                error: result.error || 'لم يتم العثور على فصول',
                mangaId: mangaId
            });
        }
        
        // حفظ الفصول في ImgChapter
        console.log(`💾 حفظ ${result.chapters.length} فصل في Firebase...`);
        
        for (const chapter of result.chapters) {
            await writeToFirebase(`ImgChapter/${mangaId}/${chapter.chapterId}`, chapter);
            console.log(`📝 حفظ: ${chapter.chapterId} - ${chapter.title}`);
            
            // تأخير بين الحفظ
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // تحديث معلومات المانجا
        await writeToFirebase(`HomeManga/${mangaId}`, {
            title: result.mangaTitle,
            totalChapters: result.chapters.length,
            status: 'chapters_ready',
            chaptersUpdatedAt: Date.now()
        });
        
        // تحديث حالة المهمة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'completed',
            chaptersCount: result.chapters.length,
            mangaTitle: result.mangaTitle,
            completedAt: Date.now()
        });
        
        console.log(`✅ تم إنشاء ${result.chapters.length} فصل في Firebase`);
        
        res.json({
            success: true,
            message: `تم معالجة ${result.chapters.length} فصل`,
            mangaId: mangaId,
            mangaTitle: result.mangaTitle,
            chaptersCount: result.chapters.length,
            chapters: result.chapters.slice(0, 5) // أول 5 فصول فقط
        });
        
    } catch (error) {
        console.error('❌ خطأ:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            mangaId: req.params.mangaId
        });
    }
});

// اختبار مانجا محددة
app.get('/test-manga/:mangaId', async (req, res) => {
    try {
        const { mangaId } = req.params;
        
        // قراءة المهمة
        const job = await readFromFirebase(`Jobs/${mangaId}`);
        
        if (!job) {
            return res.json({
                success: false,
                error: 'لم يتم العثور على المهمة',
                mangaId: mangaId
            });
        }
        
        // جلب الفصول
        const result = await getChaptersFromSite(job.mangaUrl);
        
        res.json({
            success: result.success,
            mangaTitle: result.mangaTitle,
            chaptersCount: result.chapters.length,
            sampleChapters: result.chapters.slice(0, 3),
            mangaUrl: job.mangaUrl,
            mangaId: mangaId
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// رؤية جميع المهام
app.get('/jobs', async (req, res) => {
    try {
        const jobs = await readFromFirebase('Jobs');
        
        const jobList = [];
        if (jobs) {
            for (const [mangaId, job] of Object.entries(jobs)) {
                jobList.push({
                    mangaId,
                    status: job.status,
                    title: job.title || 'بدون عنوان',
                    url: job.mangaUrl,
                    createdAt: job.createdAt
                });
            }
        }
        
        res.json({
            success: true,
            total: jobList.length,
            jobs: jobList
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// صفحة رئيسية
app.get('/', (req, res) => {
    res.send(`
        <h1>📚 البوت 2 - معالج الفصول</h1>
        
        <h2>🔗 اختبار مانجا:</h2>
        <ul>
            <li><a href="/process-manga/14584dfb5297">/process-manga/14584dfb5297</a> (Face Genius)</li>
            <li><a href="/test-manga/14584dfb5297">/test-manga/14584dfb5297</a> - اختبار فقط</li>
            <li><a href="/jobs">/jobs</a> - رؤية جميع المهام</li>
        </ul>
        
        <h2>📝 تعليمات:</h2>
        <p>1. اختر مانجا من القائمة أعلاه</p>
        <p>2. سيقوم البوت بإنشاء قسم <strong>ImgChapter</strong> في Firebase</p>
        <p>3. بعدها سيتمكن البوت 3 من العمل</p>
        
        <h2>🎯 الهدف:</h2>
        <p>إنشاء هيكل: <code>ImgChapter/mangaId/chapterId/</code></p>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`\n✅ البوت 2 يعمل على المنفذ ${PORT}`);
    console.log(`🔗 افتح: https://server-2.onrender.com`);
    console.log(`🎯 جاهز لمعالجة المهام...`);
});
