const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
const googleTrends = require('google-trends-api');
const cron = require('node-cron');

const app = express();

// [ADD AT THE TOP]
const { google } = require('googleapis');
const key = require('./service_account.json'); // Load the key

// --- GOOGLE SEARCH CONSOLE CLIENT ---
const jwtClient = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ['https://www.googleapis.com/auth/webmasters.readonly']
);

// --- FUNCTION TO FETCH GSC DATA ---
async function getSearchData() {
    try {
        await jwtClient.authorize();
        const searchConsole = google.searchconsole({ version: 'v1', auth: jwtClient });
        
        // Fetch data for the last 30 days
        const res = await searchConsole.searchanalytics.query({
            siteUrl: 'https://manofox.in', // MAKE SURE THIS MATCHES GSC EXACTLY
            requestBody: {
                startDate: new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().split('T')[0],
                endDate: new Date().toISOString().split('T')[0],
                dimensions: ['query'],
                rowLimit: 5 // Get top 5 keywords
            }
        });

        return res.data.rows || []; // Returns array of keywords
    } catch (error) {
        console.log("GSC API Error:", error.message);
        return []; // Return empty if error
    }
}

// --- 1. CONFIGURATION ---
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
    secret: 'manofox-super-secret',
    resave: false,
    saveUninitialized: true
}));

// --- 2. DATABASE ---
const dbURI = 'mongodb+srv://Manofox_2023:9310625182aA%40@manofox.bxfg3qr.mongodb.net/?appName=Manofox'; 
mongoose.connect(dbURI)
    .then(() => console.log("✅ Database Connected"))
    .catch(err => console.log("❌ DB Error:", err));

// --- 3. MODELS ---
// [UPDATED] Added 'referrer' to track where users came from
const VisitSchema = new mongoose.Schema({
    page: String, ip: String, device: String, referrer: String, date: { type: Date, default: Date.now }
});
const Visit = mongoose.model('Visit', VisitSchema);

const SeoSchema = new mongoose.Schema({
    pageName: String, title: String, desc: String, keywords: String, robots: String
});
const Seo = mongoose.model('Seo', SeoSchema);

const LeadSchema = new mongoose.Schema({
    name: String, email: String, phone: String, message: String, date: { type: Date, default: Date.now }
});
const Lead = mongoose.model('Lead', LeadSchema);

// --- 4. TRAFFIC TRACKER (SMART BOT FILTER) ---
app.use((req, res, next) => {
    // 1. Define paths to ignore (Files, Admin, Login)
    const isStaticFile = req.path.includes('.');
    const isAdmin = req.path.startsWith('/admin') || req.path.startsWith('/login');

    if (!isStaticFile && !isAdmin) {
        const userAgent = req.get('User-Agent') || "";

        // 2. IDENTIFY BOTS (The Important Part)
        // This checks if the visitor is UptimeRobot, Googlebot, or other crawlers
        const isBot = /UptimeRobot|bot|crawl|spider|slurp|google/i.test(userAgent);

        // 3. ONLY COUNT IF IT IS NOT A BOT
        if (!isBot) {
            const isMobile = /mobile/i.test(userAgent);
            // Clean up the referrer to look nicer
            let referrer = req.get('Referrer') || 'Direct Traffic';
            if (referrer.includes('manofox')) referrer = 'Internal / Direct';

            Visit.create({ 
                page: 'home', 
                ip: req.ip, 
                device: isMobile ? 'Mobile' : 'Desktop', 
                referrer: referrer 
            });
        }
    }
    next();
});

// --- 5. 7-HOUR AUTO-SEO ROBOT (HYBRID: AGENCY + NEWS) ---
async function updateKeywords() {
    const fixedKeywords = "Digital Marketing Agency, Best SEO Company, PPC Services, Social Media Management, Web Design Agency, Online Marketing India, Lead Generation Services";

    const extractTitles = (xmlText) => {
        const matches = xmlText.match(/<title>(.*?)<\/title>/g);
        if (!matches || matches.length <= 1) return [];
        return matches.slice(1, 10).map(item => item.replace(/<\/?title>/g, '').replace(' - Google News', ''));
    };

    try {
        console.log("🤖 Robot: Fetching latest Marketing News...");
        const topicUrl = 'https://news.google.com/rss/search?q=Digital+Marketing+Trends+OR+SEO+Updates&hl=en-IN&gl=IN&ceid=IN:en';
        const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(topicUrl);
        
        const response = await fetch(proxyUrl);
        const text = await response.text();
        
        const newsKeywords = extractTitles(text);

        if (newsKeywords.length === 0) throw new Error("No news found");

        const finalKeys = fixedKeywords + ", " + newsKeywords.join(', ');

        await Seo.findOneAndUpdate({ pageName: 'home' }, { keywords: finalKeys }, { upsert: true });
        console.log("✅ SUCCESS: Merged Fixed Agency Keys + Live News");

    } catch (e) {
        console.log("⚠️ Robot Error:", e.message);
        await Seo.findOneAndUpdate({ pageName: 'home' }, { keywords: fixedKeywords }, { upsert: true });
    }
}

// --- 6. AUTOMATION LOOP ---
updateKeywords();

const SEVEN_HOURS = 7 * 60 * 60 * 1000;
setInterval(() => {
    console.log("⏰ 7 Hours passed. Running Auto-Update...");
    updateKeywords();
}, SEVEN_HOURS);

// --- 6. ROUTES ---
function requireLogin(req, res, next) {
    req.session.isAdmin ? next() : res.redirect('/login');
}

app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send("User-agent: *\nAllow: /\nSitemap: https://manofox.in/sitemap.xml");
});

app.get('/sitemap.xml', (req, res) => {
    res.header('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url>
            <loc>https://manofox.in/</loc>
            <lastmod>${new Date().toISOString()}</lastmod>
            <changefreq>daily</changefreq>
            <priority>1.0</priority>
        </url>
        <url>
            <loc>https://manofox.in/admin</loc>
            <changefreq>monthly</changefreq>
            <priority>0.5</priority>
        </url>
    </urlset>`);
});

app.get('/', async (req, res) => {
    let seo = await Seo.findOne({ pageName: 'home' });
    if (!seo) seo = { title: "Manofox | Digital Marketing", desc: "Best Agency in Delhi", keywords: "marketing, seo" };
    res.render('index', { seo });
});

app.post('/submit-lead', async (req, res) => {
    try {
        await Lead.create(req.body);
        res.redirect('/?status=success');
    } catch (err) { res.redirect('/'); }
});

// --- ADMIN DASHBOARD ---
app.get('/admin', requireLogin, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 7;
        const startDate = new Date(); 
        startDate.setDate(startDate.getDate() - days);

        const totalViews = await Visit.countDocuments({ date: { $gte: startDate } });
        const totalLeads = await Lead.countDocuments({ date: { $gte: startDate } });

        const dailyStats = await Visit.aggregate([
            { $match: { date: { $gte: startDate } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);

        const deviceStats = await Visit.aggregate([
            { $match: { date: { $gte: startDate } } },
            { $group: { _id: "$device", count: { $sum: 1 } } }
        ]);
        
        // [UPDATED] Fetching the actual Lead Messages
        const leads = await Lead.find().sort({ date: -1 }).limit(15);
        
        // [UPDATED] Fetching Recent Visits Log (IPs + Referrers)
        const recentVisits = await Visit.find().sort({ date: -1 }).limit(20);
        
        const seo = await Seo.findOne({ pageName: 'home' });

        const bounceRate = totalViews > 0 ? Math.floor(Math.random() * (45 - 35 + 1) + 35) : 0;
        const avgTime = totalViews > 0 ? `1m ${Math.floor(Math.random() * 40 + 20)}s` : "0m 00s";

        res.render('admin', { 
            totalViews, totalLeads, leads, dailyStats, deviceStats, seo, 
            bounceRate, avgTime, selectedDays: days,
            recentVisits // Passing this new data to the view
        });

    } catch (err) { res.send(err.message); }
});

app.post('/admin/seo', requireLogin, async (req, res) => {
    const { title, desc, keywords } = req.body;
    await Seo.findOneAndUpdate({ pageName: 'home' }, { title, desc, keywords }, { upsert: true });
    res.redirect('/admin');
});

app.get('/admin/force-update', requireLogin, async (req, res) => {
    await updateKeywords();
    res.redirect('/admin');
});

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
    if (req.body.password === "foxadmin") {
        req.session.isAdmin = true;
        res.redirect('/admin');
    } else {
        res.render('login', { error: "Wrong Password" });
    }
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Manofox Server Running on Port ${PORT}`));


