// check-views.js
// Scrapes public TikTok profiles for their videos' view counts,
// and sends a Telegram message the first time a video crosses each milestone.
//
// Tracked profiles and results now live in the same Firestore project as the
// account tracker web app, scoped under your Firebase Auth UID.

const puppeteer = require('puppeteer');
const admin = require('firebase-admin');

const MILESTONES = [500, 1000, 5000, 10000];
const UID = process.env.FIRESTORE_UID;

// ---- Firebase init (uses a service account, bypasses client security rules) ----
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

async function sendTelegram(text){
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
  if(!res.ok){
    console.error('Telegram send failed:', await res.text());
  }
}

async function getTrackedProfiles(){
  const doc = await db.collection('trackers').doc(UID).get();
  if(!doc.exists) return [];
  return doc.data().trackedProfiles || [];
}

// Recursively search the page's embedded state for any object that looks like
// a TikTok video item ({ id, stats.playCount, author }). This is deliberately
// loose so small schema changes on TikTok's side don't break it outright.
function findVideoItems(obj, found = new Map(), depth = 0){
  if(!obj || typeof obj !== 'object' || depth > 10) return found;
  if(obj.id && obj.stats && typeof obj.stats.playCount === 'number'){
    found.set(obj.id, { id: obj.id, playCount: obj.stats.playCount });
  }
  for(const key in obj){
    if(Object.prototype.hasOwnProperty.call(obj, key)){
      findVideoItems(obj[key], found, depth + 1);
    }
  }
  return found;
}

async function scrapeProfile(browser, handle){
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );
  try{
    await page.goto(`https://www.tiktok.com/@${handle}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await wait(3000); // let client-side rendering settle

    const title = await page.title();
    const finalUrl = page.url();
    console.log(`[@${handle}] Loaded page title: "${title}" at ${finalUrl}`);

    // Save a screenshot so we can see exactly what the bot saw (CAPTCHA, block page, real content, etc.)
    try{
      const fs = require('fs');
      if(!fs.existsSync('debug-screenshots')) fs.mkdirSync('debug-screenshots');
      await page.screenshot({ path: `debug-screenshots/${handle}.png`, fullPage: false });
    }catch(shotErr){
      console.warn(`[@${handle}] Could not save debug screenshot:`, shotErr.message);
    }

    const state = await page.evaluate(() => {
      return window.__UNIVERSAL_DATA_FOR_REHYDRATION__ || window.SIGI_STATE || null;
    });

    if(!state){
      console.warn(`[@${handle}] No embedded state found — page structure may have changed, or the profile didn't load.`);
      return [];
    }

    const items = findVideoItems(state);
    console.log(`[@${handle}] Embedded state present, found ${items.size} matching video objects in it.`);
    return Array.from(items.values()).map(v => ({
      ...v,
      url: `https://www.tiktok.com/@${handle}/video/${v.id}`
    }));
  } finally {
    await page.close();
  }
}

function newMilestonesCrossed(playCount, alreadyNotified){
  return MILESTONES.filter(m => playCount >= m && !alreadyNotified.includes(m));
}

async function processVideo(video){
  const ref = db.collection('videoTracker').doc(UID).collection('videos').doc(video.id);
  const snap = await ref.get();
  const prev = snap.exists ? snap.data() : { notifiedMilestones: [] };
  const already = prev.notifiedMilestones || [];

  const toNotify = newMilestonesCrossed(video.playCount, already);
  for(const m of toNotify){
    await sendTelegram(`${m.toLocaleString()} views on this video: ${video.url}`);
    console.log(`Notified: ${video.url} hit ${m} views`);
  }

  await ref.set({
    url: video.url,
    views: video.playCount,
    notifiedMilestones: [...already, ...toNotify],
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

async function main(){
  if(!UID){
    console.error('FIRESTORE_UID env var is missing. Set it as a GitHub Actions secret.');
    process.exit(1);
  }

  const profiles = await getTrackedProfiles();
  if(profiles.length === 0){
    console.log('No tracked profiles found in Firestore — add some from the "View Tracker" tab in the app.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for(const handle of profiles){
    try{
      console.log(`Checking @${handle}...`);
      const videos = await scrapeProfile(browser, handle);
      console.log(`Found ${videos.length} videos for @${handle}`);
      for(const v of videos){
        await processVideo(v);
      }
    }catch(e){
      console.error(`Error checking @${handle}:`, e.message);
    }
  }

  await browser.close();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
