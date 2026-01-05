const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

// 🔧 الإصلاح: التأكد من وجود / في الرابط
const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// دالة قراءة Firebase
async function readFromFirebase(path) {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.log('❌ Firebase غير مهيء');
        return null;
    }
    
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
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.log('❌ Firebase غير مهيء');
        return null;
    }
    
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        const response = await axios.put(url, data, { timeout: 10000 });
        console.log(`✅ تم الكتابة إلى ${path}`);
        return response.data;
    } catch (error) {
        console.error(`❌ خطأ في الكتابة إلى ${path}:`, error.message);
        return null;
    }
}

// دالة للبحث عن مهام
async function checkForJobs() {
    console.log('🔍 البحث عن مهام...');
    
    // قراءة المهام
    const jobs = await readFromFirebase('Jobs');
    
    if (!jobs) {
        console.log('❌ لا توجد مهام أو خطأ في القراءة');
        return null;
    }
    
    console.log(`📊 عدد المهام: ${Object.keys(jobs || {}).length}`);
    
    // البحث عن أول مهمة "waiting"
    for (const [mangaId, job] of Object.entries(jobs)) {
        if (job && job.status === 'waiting') {
            console.log(`✅ وجدت مهمة: ${mangaId}`);
            return { mangaId, job };
        }
    }
    
    console.log('ℹ️ لا توجد مهام في الانتظار');
    return null;
}

// API لمعالجة المهمة التالية
app.get('/process-next', async (req, res) => {
    try {
        console.log('🚀 بدء معالجة المهمة...');
        
        const jobData = await checkForJobs();
        
        if (!jobData) {
            return res.json({ 
                success: false, 
                message: 'لا توجد مهام في الانتظار',
                tip: 'قم بتشغيل البوت 1 أولاً لإنشاء المهام'
            });
        }
        
        const { mangaId, job } = jobData;
        
        console.log(`🎯 معالجة المانجا: ${mangaId}`);
        
        // تحديث الحالة
        await writeToFirebase(`Jobs/${mangaId}`, {
            ...job,
            status: 'processing',
            startedAt: Date.now()
        });
        
        // هنا سيكون كود جلب الفصول
        // سأضيفه بعد نجاح البوت 1
        
        res.json({
            success: true,
            message: `وجدت مهمة لـ ${mangaId}`,
            mangaId,
            jobUrl: job.mangaUrl
        });
        
    } catch (error) {
        console.error('❌ خطأ:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// API لرؤية جميع المهام
app.get('/jobs', async (req, res) => {
    try {
        const jobs = await readFromFirebase('Jobs');
        
        res.json({
            success: true,
            jobsCount: jobs ? Object.keys(jobs).length : 0,
            jobs: jobs || {}
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// صفحة رئيسية
app.get('/', (req, res) => {
    res.send(`
        <h1>✅ البوت 2 يعمل</h1>
        <p><a href="/process-next">/process-next</a> - معالجة المهمة التالية</p>
        <p><a href="/jobs">/jobs</a> - رؤية جميع المهام</p>
        <p>Firebase: ${DATABASE_SECRETS ? '✅ مهيء' : '❌ غير مهيء'}</p>
        <p>Database URL: ${FIXED_DB_URL || '❌ غير محدد'}</p>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`✅ البوت 2 يعمل على المنفذ ${PORT}`);
    console.log(`🔗 Firebase: ${FIXED_DB_URL ? '✅' : '❌'}`);
    console.log(`🔗 Secrets: ${DATABASE_SECRETS ? '✅' : '❌'}`);
});
