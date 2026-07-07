// check-views.js
// Checks specific TikTok video links (pasted into the app's "Tracked videos" panel)
// for their view counts using Apify's TikTok Scraper (a paid third-party service
// that handles the actual data extraction), and sends a Telegram message the first
// time a video crosses each milestone.
//
// Tracked links and results live in the same Firestore project as the account
// tracker web app, scoped under your Firebase Auth UID.

const admin = require('firebase-admin');
const fs = require('fs');

const MILESTONES = [500, 1000, 5000, 10000];
const UID = process.env.FIRESTORE_UID;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR = 'clockworks~tiktok-scraper'; // "TikTok Scraper" by Clockworks on Apify

// ---- Firebase init (uses a service account, bypasses client security rules) ----
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

async function fetchViewsViaApify(videoUrl){
  if(!APIFY_TOKEN){
    throw new Error('APIFY_TOKEN env var is missing. Set it as a GitHub Actions secret.');
  }
  const endpoint = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postURLs: [videoUrl],
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSubtitles: false,
      shouldDownloadSlideshowImages: false
    })
  });

  if(!res.ok){
    const text = await res.text();
    throw new Error(`Apify request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const items = await res.json();

  // Save the raw response for troubleshooting if the field names ever shift.
  try{
    if(!fs.existsSync('debug-data')) fs.mkdirSync('debug-data');
    const videoId = extractVideoId(videoUrl) || 'unknown';
    fs.writeFileSync(`debug-data/${videoId}-apify-response.json`, JSON.stringify(items, null, 2));
  }catch(e){ /* non-fatal */ }

  if(!items || items.length === 0){
    console.warn(`Apify returned no items for ${videoUrl}`);
    return null;
  }
  const item = items[0];
  if(item.errorCode){
    console.warn(`Apify reported an error for ${videoUrl}: ${item.errorCode} ${item.errorMessage || ''}`);
    return null;
  }
  if(typeof item.playCount !== 'number'){
    console.warn(`No numeric playCount in Apify result for ${videoUrl}. Keys present: ${Object.keys(item).join(', ')}`);
    return null;
  }
  return item.playCount;
}

function newMilestonesCrossed(playCount, alreadyNotified){
  return MILESTONES.filter(m => playCount >= m && !alreadyNotified.includes(m));
}

async function processVideo(videoUrl, playCount){
  const videoId = extractVideoId(videoUrl);
  if(!videoId) return;

  const ref = db.collection('videoTracker').doc(UID).collection('videos').doc(videoId);
  const snap = await ref.get();
  const prev = snap.exists ? snap.data() : { notifiedMilestones: [] };
  const already = prev.notifiedMilestones || [];

  const toNotify = newMilestonesCrossed(playCount, already);
  for(const m of toNotify){
    await sendTelegram(`${m.toLocaleString()} views on this video: ${videoUrl}`);
    console.log(`Notified: ${videoUrl} hit ${m} views`);
  }

  await ref.set({
    url: videoUrl,
    views: playCount,
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

  for(const link of links){
    try{
      console.log(`Checking ${link} via Apify...`);
      const views = await fetchViewsViaApify(link);
      if(views !== null){
        console.log(`${link} → ${views.toLocaleString()} views`);
        await processVideo(link, views);
      }
    }catch(e){
      console.error(`Error checking ${link}:`, e.message);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
