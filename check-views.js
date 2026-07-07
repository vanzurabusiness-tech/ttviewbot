// check-views.js
// Checks specific TikTok video links (that you paste into the app's "Tracked videos"
// panel) for their view counts, and sends a Telegram message the first time a video
// crosses each milestone.
//
// Tracked links and results live in the same Firestore project as the account
// tracker web app, scoped under your Firebase Auth UID.

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const admin = require('firebase-admin');
const fs = require('fs');

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

async function getTrackedVideoLinks(){
  const doc = await db.collection('trackers').doc(UID).get();
  if(!doc.exists) return [];
  return doc.data().trackedVideoLinks || [];
}

function extractVideoId(url){
  const m = url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

// Recursively search the page's embedded state for any object that looks like
// a TikTok video item ({ id, stats.playCount }). Loose on purpose so small
// schema changes on TikTok's side don't break it outright.
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

async function checkVideo(browser, videoUrl){
  const videoId = extractVideoId(videoUrl);
  if(!videoId){
    console.warn(`Could not parse a video ID out of: ${videoUrl}`);
    return null;
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );
  try{
    await page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await wait(3000);

    const title = await page.title();
    const finalUrl = page.url();
    console.log(`[${videoId}] Page title: "${title}"`);
    console.log(`[${videoId}] Final URL after load: ${finalUrl}`);

    try{
      if(!fs.existsSync('debug-screenshots')) fs.mkdirSync('debug-screenshots');
      await page.screenshot({ path: `debug-screenshots/${videoId}.png` });
    }catch(e){
      console.warn(`[${videoId}] Could not save screenshot:`, e.message);
    }

    const blocked = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('Something went wrong') || text.includes('Drag the slider') || text.includes('Verify to continue');
    });
    if(blocked){
      console.warn(`[${videoId}] Hit a CAPTCHA / block page — skipping, not attempting to solve it.`);
      return null;
    }

    const debugInfo = await page.evaluate(() => {
      const hasUniversal = !!window.__UNIVERSAL_DATA_FOR_REHYDRATION__;
      const hasSigi = !!window.SIGI_STATE;
      return { hasUniversal, hasSigi };
    });
    console.log(`[${videoId}] window.__UNIVERSAL_DATA_FOR_REHYDRATION__ present: ${debugInfo.hasUniversal}, window.SIGI_STATE present: ${debugInfo.hasSigi}`);

    const state = await page.evaluate(() => {
      return window.__UNIVERSAL_DATA_FOR_REHYDRATION__ || window.SIGI_STATE || null;
    });
    if(!state){
      console.warn(`[${videoId}] No embedded state object found on the page at all.`);
      return null;
    }

    const items = findVideoItems(state);
    console.log(`[${videoId}] Scanned embedded state, found ${items.size} objects that look like video stats. IDs found: ${Array.from(items.keys()).join(', ') || '(none)'}`);

    const match = items.get(videoId) || Array.from(items.values())[0];
    if(!match){
      console.warn(`[${videoId}] No matching video stats object found in the embedded state.`);
      return null;
    }

    console.log(`[${videoId}] ${match.playCount.toLocaleString()} views`);
    return { id: videoId, playCount: match.playCount, url: videoUrl };
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

  const links = await getTrackedVideoLinks();
  if(links.length === 0){
    console.log('No tracked video links found in Firestore — add some from the "View Tracker" tab in the app.');
    return;
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  for(const link of links){
    try{
      console.log(`Checking ${link}...`);
      const result = await checkVideo(browser, link);
      if(result) await processVideo(result);
    }catch(e){
      console.error(`Error checking ${link}:`, e.message);
    }
  }

  await browser.close();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
