const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// 📱 نفس قائمة User-Agents من البوت 1
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

// 🔄 قائمة بروكسيات
const PROXIES = [
    '',
    'https://cors-anywhere.herokuapp.com/',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://proxy.cors.sh/'
];

// دالة عشوائية
function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// دالة محاولة جميع البروكسيات
async function fetchWithProxies(url) {
    const errors = [];
    
    for (const proxy of PROXIES) {
        try {
            let targetUrl = url;
            
            if (proxy) {
                if (proxy.includes('?')) {
                    targetUrl = proxy + encodeURIComponent(url);
                } else {
                    targetUrl = proxy + url;
                }
            }
            
            console.log(`🔄 المحاولة مع: ${proxy || 'بدون بروكسي'}`);
            
            const response = await axios.get(targetUrl, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Referer': 'https://azoramoon.com/'
                },
                timeout: 15000
            });
            
            if (response.status === 200) {
                console.log(`✅ نجح مع ${proxy || 'بدون بروكسي'}`);
                return response.data;
            } else {
                console.log(`⚠️ حالة ${response.status} مع ${proxy || 'بدون بروكسي'}`);
            }
        } catch (error) {
            errors.push(`${proxy || 'بدون بروكسي'}: ${error.message}`);
            console.log(`❌ فشل مع ${proxy || 'بدون بروكسي'}: ${error.message}`);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    throw new Error(`فشل جميع المحاولات: ${errors.join(', ')}`);
}

// دالة قراءة Firebase
async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
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

// دالة لجلب الفصول
async function getChaptersWithRetry(mangaUrl) {
    console.log(`\n🎯 محاولة جلب الفصول من: ${mangaUrl}`);
    
    try {
        // المحاولة 1: مباشرة
        try {
            console.log('1️⃣ المحاولة المباشرة');
            const response = await axios.get(mangaUrl, {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: 20000
            });
            
            const $ = cheerio.load(response.data);
            const chapters = extractChapters($);
            
            if (chapters.length > 0) {
                console.log(`✅ نجحت المحاولة المباشرة: ${chapters.length} فصل`);
                return chapters;
            }
        } catch (error) {
            console.log('❌ فشلت المحاولة المباشرة:', error.message);
        }
        
        // المحاولة 2: مع بروكسيات
        console.log('2️⃣ محاولة مع بروكسيات');
        const html = await fetchWithProxies(mangaUrl);
        const $ = cheerio.load(html);
        const chapters = extractChapters($);
        
        if (chapters.length > 0) {
            console.log(`✅ نجحت مع البروكسيات: ${chapters.length} فصل`);
            return chapters;
        }
        
        throw new Error('لم يتم العثور على فصول بعد جميع المحاولات');
        
    } catch (error) {
        console.error('❌ خطأ في جلب الفصول:', error.message);
        return [];
    }
}

// دالة استخراج الفصول
function extractChapters($) {
    const chapters = [];
    
    // محاولة عدة انتقاءات
    const chapterSelectors = [
        '.wp-manga-chapter',
        '.chapter-item',
        '.listing-chapters_wrap a',
        'ul.main.version-chap li'
    ];
    
    for (const selector of chapterSelectors) {
        const elements = $(selector);
        if (elements.length > 0) {
            console.log(`✅ وجد ${elements.length} فصل بـ "${selector}"`);
            
            elements.each((i, element) => {
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
                        test: chapterLink.startsWith('http') ? chapterLink : `https://azoramoon.com${chapterLink}`,
                        createdAt: Date.now()
                    });
                }
            });
            break;
        }
    }
    
    return chapters;
}

// API اختبار الموقع
app.get('/test-site/:mangaId', async (req, res) => {
    try {
        const { mangaId } = req.params;
        
        // قراءة المهمة
        const job = await readFromFirebase(`Jobs/${mangaId}`);
        
        if (!job) {
            return res.json({
                success: false,
                error: 'لم يتم العثور على المهمة'
            });
        }
        
        console.log(`🔗 اختبار الموقع: ${job.mangaUrl}`);
        
        // اختبار مباشر
        try {
            const response = await axios.get(job.mangaUrl, {
                headers: { 'User-Agent': getRandomUserAgent() },
                timeout: 10000
            });
            
            const $ = cheerio.load(response.data);
            const title = $('.post-title h1').text().trim() || $('h1').first().text().trim();
            
            res.json({
                success: true,
                status: response.status,
                title: title,
                url: job.mangaUrl,
                message: 'الموقع يستجيب'
            });
            
        } catch (error) {
            res.json({
                success: false,
                error: error.message,
                status: error.response?.status,
                url: job.mangaUrl,
                message: 'الموقع لا يستجيب'
            });
        }
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API معالجة يدوية
app.get('/manual-process/:mangaId', async (req, res) => {
    try {
        const { mangaId } = req.params;
        
        console.log(`\n🎯 معالجة يدوية: ${mangaId}`);
        
        // قراءة المهمة
        const job = await readFromFirebase(`Jobs/${mangaId}`);
        
        if (!job) {
            return res.json({
                success: false,
                error: 'لم يتم العثور على المهمة'
            });
        }
        
        console.log(`📖 المانجا: ${job.title || 'بدون عنوان'}`);
        console.log(`🔗 الرابط: ${job.mangaUrl}`);
        
        // جلب الفصول
        const chapters = await getChaptersWithRetry(job.mangaUrl);
        
        if (chapters.length === 0) {
            return res.json({
                success: false,
                error: 'لم يتم العثور على أي فصل',
                mangaId: mangaId,
                url: job.mangaUrl,
                suggestion: 'جرب فتح الرابط يدوياً في متصفح'
            });
        }
        
        console.log(`📊 تم العثور على ${chapters.length} فصل`);
        
        // حفظ في Firebase
        for (const chapter of chapters) {
            await writeToFirebase(`ImgChapter/${mangaId}/${chapter.chapterId}`, chapter);
            console.log(`📝 حفظ: ${chapter.chapterId} - ${chapter.title}`);
        }
        
        // تحديث حالة المهمة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'completed',
            chaptersCount: chapters.length,
            completedAt: Date.now()
        });
        
        // تحديث HomeManga
        const mangaInfo = await readFromFirebase(`HomeManga/${mangaId}`) || {};
        await writeToFirebase(`HomeManga/${mangaId}`, {
            ...mangaInfo,
            totalChapters: chapters.length,
            status: 'chapters_ready',
            chaptersUpdatedAt: Date.now()
        });
        
        res.json({
            success: true,
            message: `تم حفظ ${chapters.length} فصل`,
            mangaId: mangaId,
            chaptersCount: chapters.length,
            firstChapter: chapters[0],
            lastChapter: chapters[chapters.length - 1]
        });
        
    } catch (error) {
        console.error('❌ خطأ:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            mangaId: req.params.mangaId
        });
    }
});

// صفحة رئيسية
app.get('/', (req, res) => {
    res.send(`
        <h1>🔧 البوت 2 - النسخة المتطورة</h1>
        
        <h2>🎯 اختبارات مباشرة:</h2>
        <ul>
            <li><a href="/test-site/14584dfb5297">/test-site/14584dfb5297</a> - اختبار الموقع</li>
            <li><a href="/manual-process/14584dfb5297">/manual-process/14584dfb5297</a> - معالجة يدوية</li>
            <li><a href="/manual-process/35ee65f73457">/manual-process/35ee65f73457</a> - White Tiger Princess</li>
            <li><a href="/manual-process/c5e1f11a5bd2">/manual-process/c5e1f11a5bd2</a> - Princess is Evil</li>
        </ul>
        
        <h2>⚙️ المعلومات:</h2>
        <p>عدد User-Agents: ${USER_AGENTS.length}</p>
        <p>عدد البروكسيات: ${PROXIES.length}</p>
        <p>الهدف: إنشاء قسم <code>ImgChapter</code> في Firebase</p>
        
        <h2>📝 التعليمات:</h2>
        <ol>
            <li>اختبر أولاً إذا كان الموقع يفتح</li>
            <li>جرب معالجة مانجا مختلفة</li>
            <li>تحقق من Firebase بعد المعالجة</li>
        </ol>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`\n✅ البوت 2 المعدل يعمل على المنفذ ${PORT}`);
    console.log(`🔗 افتح: https://server-2.onrender.com`);
    console.log(`🎯 جاهز لاختبار المواقع...`);
});
