const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10001;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// دالة لاختبار Firebase
async function testFirebaseConnection() {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        return { success: false, error: 'مفاتيح Firebase غير موجودة' };
    }
    
    try {
        const testUrl = `${FIXED_DB_URL}test_connection.json?auth=${DATABASE_SECRETS}`;
        await axios.put(testUrl, { test: Date.now() }, { timeout: 5000 });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// دالة قراءة Firebase
async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        console.log(`📖 قراءة: ${path}`);
        const response = await axios.get(url, { timeout: 10000 });
        return response.data;
    } catch (error) {
        console.error(`❌ خطأ في قراءة ${path}:`, error.message);
        
        // محاولة بدون auth
        if (error.message.includes('auth')) {
            try {
                const urlNoAuth = `${FIXED_DB_URL}${path}.json`;
                const response = await axios.get(urlNoAuth, { timeout: 10000 });
                console.log(`✅ قراءة بدون auth`);
                return response.data;
            } catch (error2) {
                console.error(`❌ فشل القراءة بدون auth:`, error2.message);
            }
        }
        
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
        
        // محاولة بدون auth
        if (error.message.includes('auth')) {
            try {
                const urlNoAuth = `${FIXED_DB_URL}${path}.json`;
                const response = await axios.put(urlNoAuth, data, { timeout: 10000 });
                console.log(`✅ كتابة بدون auth`);
                return response.data;
            } catch (error2) {
                console.error(`❌ فشل الكتابة بدون auth:`, error2.message);
            }
        }
        
        return null;
    }
}

// دالة لجلب الفصول
async function scrapeChapters(mangaUrl, mangaId) {
    console.log(`\n📚 جلب الفصول من: ${mangaUrl}`);
    
    try {
        const response = await axios.get(mangaUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        
        // استخراج العنوان
        const mangaTitle = $('.post-title h1').text().trim() || 
                          $('h1.entry-title').text().trim() ||
                          $('h1').first().text().trim();
        
        console.log(`📖 مانجا: ${mangaTitle}`);
        
        // استخراج الفصول
        const chapters = [];
        
        // محاولة عدة اختيارات
        const chapterSelectors = [
            '.wp-manga-chapter',
            '.chapter-item',
            '.listing-chapters_wrap a',
            '.chapter-list a',
            '.chapter-list li a',
            'a[href*="/chapter"]',
            'a[href*="/read"]'
        ];
        
        for (const selector of chapterSelectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                console.log(`✅ وجد ${elements.length} فصل بـ "${selector}"`);
                
                elements.each((i, element) => {
                    const $el = $(element);
                    const chapterUrl = $el.attr('href');
                    const chapterTitle = $el.text().trim();
                    
                    if (chapterUrl && chapterTitle) {
                        // استخراج رقم الفصل
                        const chapterNumMatch = chapterTitle.match(/(\d+)/);
                        const chapterNum = chapterNumMatch ? parseInt(chapterNumMatch[1]) : i + 1;
                        
                        chapters.push({
                            chapterId: `ch_${chapterNum.toString().padStart(4, '0')}`,
                            chapterNumber: chapterNum,
                            title: chapterTitle,
                            url: chapterUrl.startsWith('http') ? chapterUrl : `https://azoramoon.com${chapterUrl}`,
                            status: 'pending_images',
                            test: chapterUrl.startsWith('http') ? chapterUrl : `https://azoramoon.com${chapterUrl}`,
                            createdAt: Date.now(),
                            order: chapters.length
                        });
                    }
                });
                break;
            }
        }
        
        console.log(`📊 عدد الفصول: ${chapters.length}`);
        
        // ترتيب من الأقدم للأحدث
        chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        
        return { 
            success: true, 
            mangaTitle, 
            chapters,
            total: chapters.length
        };
        
    } catch (error) {
        console.error(`❌ خطأ في جلب الفصول:`, error.message);
        return { success: false, error: error.message };
    }
}

// دالة للبحث عن المهام
async function findPendingJobs() {
    console.log('\n🔍 البحث عن مهام...');
    
    try {
        const jobs = await readFromFirebase('Jobs');
        
        if (!jobs) {
            console.log('ℹ️ لا توجد مهام أو خطأ في القراءة');
            return [];
        }
        
        const pendingJobs = [];
        
        for (const [mangaId, job] of Object.entries(jobs)) {
            if (job && job.status === 'waiting') {
                pendingJobs.push({
                    mangaId,
                    job,
                    priority: job.createdAt || Date.now()
                });
            }
        }
        
        // ترتيب حسب الأولوية
        pendingJobs.sort((a, b) => a.priority - b.priority);
        
        console.log(`📋 وجدت ${pendingJobs.length} مهمة قيد الانتظار`);
        return pendingJobs;
        
    } catch (error) {
        console.error('❌ خطأ في البحث عن المهام:', error.message);
        return [];
    }
}

// معالجة مهمة واحدة
async function processJob(mangaId, job) {
    console.log(`\n🎯 معالجة المهمة: ${mangaId}`);
    
    try {
        // تحديث الحالة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'processing',
            startedAt: Date.now()
        });
        
        // جلب الفصول
        const result = await scrapeChapters(job.mangaUrl, mangaId);
        
        if (!result.success || result.chapters.length === 0) {
            // تحديث بالفشل
            await writeToFirebase(`Jobs/${mangaId}`, {
                ...job,
                status: 'failed',
                error: result.error || 'لم يتم العثور على فصول',
                completedAt: Date.now()
            });
            
            await writeToFirebase(`HomeManga/${mangaId}/status`, 'chapters_failed');
            
            return {
                success: false,
                error: result.error || 'لم يتم العثور على فصول'
            };
        }
        
        // تحديث معلومات المانجا
        await writeToFirebase(`HomeManga/${mangaId}`, {
            title: result.mangaTitle,
            totalChapters: result.chapters.length,
            status: 'chapters_ready',
            chaptersUpdatedAt: Date.now(),
            ...(job.title ? {} : { title: result.mangaTitle })
        });
        
        // حفظ الفصول
        console.log(`💾 حفظ ${result.chapters.length} فصل...`);
        
        let savedChapters = 0;
        for (const chapter of result.chapters) {
            try {
                await writeToFirebase(`ImgChapter/${mangaId}/${chapter.chapterId}`, chapter);
                savedChapters++;
                
                // تأخير بسيط بين الحفظ
                if (savedChapters % 10 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
            } catch (error) {
                console.error(`❌ خطأ في حفظ الفصل ${chapter.chapterId}:`, error.message);
            }
        }
        
        // تحديث حالة المهمة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'completed',
            chaptersCount: savedChapters,
            mangaTitle: result.mangaTitle,
            completedAt: Date.now()
        });
        
        console.log(`✅ تم معالجة ${savedChapters}/${result.chapters.length} فصل`);
        
        return {
            success: true,
            mangaTitle: result.mangaTitle,
            chaptersCount: savedChapters,
            totalChapters: result.chapters.length
        };
        
    } catch (error) {
        console.error(`❌ خطأ في معالجة المهمة ${mangaId}:`, error.message);
        
        try {
            await writeToFirebase(`Jobs/${mangaId}`, {
                ...job,
                status: 'error',
                error: error.message,
                failedAt: Date.now()
            });
        } catch (e) {
            console.error('❌ فشل تحديث حالة الخطأ:', e.message);
        }
        
        return {
            success: false,
            error: error.message
        };
    }
}

// API لمعالجة المهمة التالية
app.get('/process-next', async (req, res) => {
    try {
        console.log('\n🚀 طلب معالجة المهمة التالية');
        
        const pendingJobs = await findPendingJobs();
        
        if (pendingJobs.length === 0) {
            return res.json({
                success: false,
                message: 'لا توجد مهام في الانتظار',
                tip: 'قم بتشغيل البوت 1 أولاً'
            });
        }
        
        const nextJob = pendingJobs[0];
        const result = await processJob(nextJob.mangaId, nextJob.job);
        
        res.json({
            success: result.success,
            ...result,
            mangaId: nextJob.mangaId,
            jobTitle: nextJob.job.title || 'بدون عنوان'
        });
        
    } catch (error) {
        console.error('❌ خطأ في /process-next:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// معالجة جميع المهام
app.get('/process-all', async (req, res) => {
    try {
        console.log('\n🚀 معالجة جميع المهام');
        
        const pendingJobs = await findPendingJobs();
        
        if (pendingJobs.length === 0) {
            return res.json({
                success: false,
                message: 'لا توجد مهام في الانتظار'
            });
        }
        
        const results = [];
        
        for (const job of pendingJobs.slice(0, 5)) { // 5 مهام كحد أقصى
            console.log(`\n📋 المهمة ${results.length + 1}/${Math.min(pendingJobs.length, 5)}`);
            const result = await processJob(job.mangaId, job.job);
            results.push({
                mangaId: job.mangaId,
                ...result
            });
            
            // تأخير بين المهام
            if (results.length < pendingJobs.length && results.length < 5) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        
        res.json({
            success: true,
            message: `تم معالجة ${results.length} مهمة`,
            results,
            totalPending: pendingJobs.length
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// رؤية المهام
app.get('/jobs', async (req, res) => {
    try {
        const jobs = await readFromFirebase('Jobs');
        const homeManga = await readFromFirebase('HomeManga');
        
        const jobList = [];
        if (jobs) {
            for (const [mangaId, job] of Object.entries(jobs)) {
                const mangaInfo = homeManga ? homeManga[mangaId] : null;
                jobList.push({
                    mangaId,
                    status: job.status,
                    title: job.title || (mangaInfo ? mangaInfo.title : 'غير معروف'),
                    url: job.mangaUrl,
                    createdAt: job.createdAt,
                    chaptersCount: job.chaptersCount
                });
            }
        }
        
        res.json({
            success: true,
            totalJobs: jobList.length,
            jobs: jobList
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// اختبار Firebase
app.get('/test-firebase', async (req, res) => {
    try {
        const testResult = await testFirebaseConnection();
        
        if (testResult.success) {
            const sampleData = await readFromFirebase('Jobs');
            
            res.json({
                success: true,
                message: 'Firebase يعمل',
                connection: '✅ متصل',
                jobsCount: sampleData ? Object.keys(sampleData).length : 0,
                sample: sampleData ? Object.keys(sampleData).slice(0, 3) : []
            });
        } else {
            res.json({
                success: false,
                message: 'Firebase غير متصل',
                error: testResult.error,
                suggestion: 'تحقق من DATABASE و DATABASE_SECRETS في Render'
            });
        }
        
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
        
        <h2>🔗 الروابط:</h2>
        <ul>
            <li><a href="/process-next">/process-next</a> - معالجة المهمة التالية</li>
            <li><a href="/process-all">/process-all</a> - معالجة جميع المهام (5 كحد أقصى)</li>
            <li><a href="/jobs">/jobs</a> - رؤية جميع المهام</li>
            <li
