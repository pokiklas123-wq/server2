const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT_2 || 3002;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE_URL;

// رؤوس HTTP ثابتة
const FIXED_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Referer': 'https://azoramoon.com/',
    'Upgrade-Insecure-Requests': '1'
};

// Firebase Helper
class FirebaseHelper {
    constructor() {
        this.baseUrl = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;
        this.secret = DATABASE_SECRETS;
    }

    async read(path) {
        try {
            const url = `${this.baseUrl}${path}.json?auth=${this.secret}`;
            const response = await axios.get(url, { timeout: 10000 });
            return response.data;
        } catch (error) {
            console.log(`❌ خطأ في قراءة ${path}:`, error.message);
            return null;
        }
    }

    async write(path, data) {
        try {
            const url = `${this.baseUrl}${path}.json?auth=${this.secret}`;
            await axios.put(url, data, { 
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' }
            });
            return true;
        } catch (error) {
            console.log(`❌ خطأ في كتابة ${path}:`, error.message);
            return false;
        }
    }

    async update(path, updates) {
        try {
            const current = await this.read(path) || {};
            const updated = { ...current, ...updates };
            return await this.write(path, updated);
        } catch (error) {
            return false;
        }
    }
}

const db = new FirebaseHelper();

// نظام معالجة المهمات
class ChapterProcessor {
    constructor() {
        this.isProcessing = false;
        this.currentJob = null;
    }

    async start() {
        if (this.isProcessing) return;
        
        this.isProcessing = true;
        console.log('🚀 بدء معالجة الفصول...');
        
        // بدء المعالجة التلقائية
        this.processQueue();
    }

    async processQueue() {
        while (this.isProcessing) {
            try {
                // البحث عن مهمة
                const job = await this.getNextJob();
                
                if (job) {
                    console.log(`\n🎯 معالجة: ${job.title}`);
                    await this.processJob(job);
                } else {
                    console.log('⏳ لا توجد مهمات، انتظار 30 ثانية...');
                    await this.delay(30000);
                }
                
            } catch (error) {
                console.error('❌ خطأ في المعالجة:', error.message);
                await this.delay(10000);
            }
        }
    }

    async getNextJob() {
        const jobs = await db.read('Jobs') || {};
        
        // أولوية: pending أولاً، ثم needs_update
        for (const [id, job] of Object.entries(jobs)) {
            if (job.status === 'pending') {
                return { id, ...job };
            }
        }
        
        for (const [id, job] of Object.entries(jobs)) {
            if (job.status === 'needs_update') {
                return { id, ...job };
            }
        }
        
        return null;
    }

    async processJob(job) {
        // تحديث حالة المهمة
        await db.update(`Jobs/${job.id}`, {
            status: 'processing',
            lastAttempt: Date.now(),
            attempts: (job.attempts || 0) + 1
        });
        
        try {
            // جلب الفصول
            const chapters = await this.fetchChapters(job.mangaUrl);
            
            if (chapters.length === 0) {
                throw new Error('لم يتم العثور على فصول');
            }
            
            console.log(`📚 تم العثور على ${chapters.length} فصل`);
            
            // حفظ الفصول
            await this.saveChapters(job.id, chapters);
            
            // تحديث الحالة النهائية
            await db.update(`Jobs/${job.id}`, {
                status: 'completed',
                completedAt: Date.now(),
                chaptersCount: chapters.length
            });
            
            // تحديث HomeManga
            await db.update(`HomeManga/${job.id}`, {
                status: 'chapters_ready',
                totalChapters: chapters.length,
                chaptersUpdatedAt: Date.now()
            });
            
            console.log(`✅ تم معالجة ${job.title} بنجاح`);
            
        } catch (error) {
            console.error(`❌ فشل معالجة ${job.title}:`, error.message);
            
            await db.update(`Jobs/${job.id}`, {
                status: 'failed',
                error: error.message,
                failedAt: Date.now()
            });
        }
    }

    async fetchChapters(mangaUrl) {
        console.log(`📥 جلب الفصول من: ${mangaUrl}`);
        
        const response = await axios.get(mangaUrl, {
            headers: FIXED_HEADERS,
            timeout: 20000
        });
        
        const $ = cheerio.load(response.data);
        const chapters = [];
        
        // استخراج الفصول
        $('.wp-manga-chapter a').each((i, element) => {
            const chapterUrl = $(element).attr('href');
            const chapterTitle = $(element).text().trim();
            
            if (chapterUrl && chapterTitle) {
                const chapterMatch = chapterTitle.match(/(\d+)/);
                const chapterNum = chapterMatch ? parseInt(chapterMatch[1]) : i + 1;
                
                chapters.push({
                    chapterId: `ch_${chapterNum.toString().padStart(4, '0')}`,
                    chapterNumber: chapterNum,
                    title: chapterTitle,
                    url: chapterUrl,
                    status: 'pending_images',
                    createdAt: Date.now()
                });
            }
        });
        
        // ترتيب تصاعدي
        chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
        
        return chapters;
    }

    async saveChapters(mangaId, chapters) {
        console.log(`💾 حفظ ${chapters.length} فصل في Firebase...`);
        
        // حذف القديم إذا كان تحديث
        await db.write(`ImgChapter/${mangaId}`, {});
        
        // حفظ الجديد
        for (const chapter of chapters) {
            await db.write(`ImgChapter/${mangaId}/${chapter.chapterId}`, chapter);
        }
        
        console.log(`✅ تم حفظ الفصول لـ ${mangaId}`);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// تشغيل المعالج
const processor = new ChapterProcessor();

// APIs
app.get('/', async (req, res) => {
    const jobs = await db.read('Jobs') || {};
    const chapters = await db.read('ImgChapter') || {};
    
    const stats = {
        totalJobs: Object.keys(jobs).length,
        pending: Object.values(jobs).filter(j => j.status === 'pending').length,
        processing: Object.values(jobs).filter(j => j.status === 'processing').length,
        completed: Object.values(jobs).filter(j => j.status === 'completed').length,
        totalMangaWithChapters: Object.keys(chapters).length
    };
    
    res.json({
        server: '2 - جامع الفصول',
        status: processor.isProcessing ? 'processing' : 'idle',
        stats: stats,
        currentJob: processor.currentJob,
        endpoints: {
            '/start': 'بدء المعالجة',
            '/stop': 'إيقاف المعالجة',
            '/jobs': 'عرض المهمات',
            '/process-now': 'معالجة فورية'
        }
    });
});

app.get('/start', async (req, res) => {
    await processor.start();
    res.json({ success: true, message: 'بدأت المعالجة' });
});

app.get('/process-now', async (req, res) => {
    const job = await processor.getNextJob();
    
    if (!job) {
        return res.json({ success: false, message: 'لا توجد مهمات' });
    }
    
    await processor.processJob(job);
    res.json({ success: true, message: `تمت معالجة ${job.title}` });
});

app.get('/jobs', async (req, res) => {
    const jobs = await db.read('Jobs') || {};
    
    res.json({
        total: Object.keys(jobs).length,
        jobs: Object.entries(jobs).map(([id, job]) => ({
            id,
            title: job.title,
            status: job.status,
            attempts: job.attempts || 0,
            createdAt: job.createdAt,
            lastAttempt: job.lastAttempt
        }))
    });
});

// بدء المعالجة تلقائياً
app.listen(PORT, async () => {
    console.log(`✅ السيرفر 2 يعمل على المنفذ ${PORT}`);
    console.log(`🔗 الرابط: https://server-2-n9s3.onrender.com`);
    
    // بدء المعالجة بعد 5 ثواني
    setTimeout(async () => {
        await processor.start();
    }, 5000);
});
