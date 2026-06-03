require('dotenv').config();

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const pino   = require('pino');
const axios  = require('axios');
const cron   = require('node-cron');
const { exec } = require('child_process');
const fs     = require('fs');
const Groq   = require('groq-sdk');

// ── GROQ ─────────────────────────────────────────────────────
const groq = process.env.GROQ_API_KEY
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

// ── CONFIG ───────────────────────────────────────────────────
const CONFIG = {
  prefix:         '!',
  inviteGate:     2,
  maxLinks:       2,
  spamLimit:      5,
  spamWindow:     10000,
  timezone:       'Africa/Nairobi',
  sessionDir:     './session',
  metaCacheTTL:   5 * 60 * 1000   // 5 minutes in ms
};

const PORN_DOMAINS = [
  'pornhub.com','xvideos.com','xnxx.com','xhamster.com',
  'redtube.com','youporn.com','spankbang.com','beeg.com'
];

// ── STATE ────────────────────────────────────────────────────
const inviteCount    = {};
const warnings       = {};
const spamTracker    = {};
const approvedUsers  = new Set();
const celebDone      = new Set();
let   isReconnecting = false;

// ── GROUP METADATA CACHE ──────────────────────────────────────
// Keyed by gid → { participants, fetchedAt }
// This avoids hammering WhatsApp with groupMetadata() on every message.
const metaCache = {};

const getCachedMeta = async (sock, gid) => {
  const now = Date.now();
  if (metaCache[gid] && (now - metaCache[gid].fetchedAt) < CONFIG.metaCacheTTL) {
    return metaCache[gid].data;
  }
  const data = await sock.groupMetadata(gid);
  metaCache[gid] = { data, fetchedAt: now };
  return data;
};

// Call this after any admin change so the cache doesn't serve stale data.
const invalidateCache = (gid) => { delete metaCache[gid]; };

// ── SESSION DIRECTORY & PERSISTENCE ──────────────────────────
// Railway wipes the filesystem on every redeploy, so session files are lost
// and the bot needs re-pairing each time. The fix: encode the session folder
// as a Base64 JSON string stored in a Railway environment variable called
// SESSION_DATA. On startup we restore it; after every creds update we
// re-encode and log it (and optionally push it back via the Railway API).
//
// SETUP (one-time):
//   1. Deploy and pair the bot once.
//   2. Copy the "SESSION_SAVED=..." line from the Railway logs.
//   3. In Railway → your service → Variables, add:
//        SESSION_DATA = <the base64 string you copied>
//   4. For automatic saving add these three Railway vars too:
//        RAILWAY_TOKEN            = your Railway API token
//        RAILWAY_PROJECT_ID       = your project ID (service settings)
//        RAILWAY_SERVICE_ID       = your service ID (service settings)
//   After that, redeploys will restore the session automatically.

try {
  fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
  process.stdout.write('Session directory ready: ' + CONFIG.sessionDir + '\n');
} catch (e) {
  process.stdout.write('Could not create session dir: ' + e.message + '\n');
}

const restoreSession = () => {
  const raw = process.env.SESSION_DATA;
  if (!raw) {
    process.stdout.write('No SESSION_DATA env var found — fresh session.\n');
    return;
  }
  try {
    const files = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(CONFIG.sessionDir + '/' + name, content, 'utf8');
    }
    process.stdout.write('Session restored from SESSION_DATA ✅\n');
  } catch (e) {
    process.stdout.write('Session restore failed (bad SESSION_DATA?): ' + e.message + '\n');
  }
};
restoreSession();

const saveSessionToEnv = async () => {
  try {
    const dir   = CONFIG.sessionDir;
    const files = {};
    for (const name of fs.readdirSync(dir)) {
      const full = dir + '/' + name;
      if (fs.statSync(full).isFile()) {
        files[name] = fs.readFileSync(full, 'utf8');
      }
    }
    const encoded = Buffer.from(JSON.stringify(files)).toString('base64');

    // Always print it — copy this from logs if you need to set SESSION_DATA manually
    process.stdout.write('SESSION_SAVED=' + encoded + '\n');

    // Auto-push to Railway if credentials are provided
    const token     = process.env.RAILWAY_TOKEN;
    const serviceId = process.env.RAILWAY_SERVICE_ID;
    const projectId = process.env.RAILWAY_PROJECT_ID;
    const envName   = process.env.RAILWAY_ENVIRONMENT_NAME || 'production';

    if (token && serviceId && projectId) {
      await axios.post(
        'https://backboard.railway.app/graphql/v2',
        {
          query: `mutation UpsertEnvVar($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
          }`,
          variables: {
            input: {
              projectId,
              serviceId,
              environmentName: envName,
              variables: { SESSION_DATA: encoded }
            }
          }
        },
        { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }
      ).catch(e => process.stdout.write('Railway API save error: ' + e.message + '\n'));
      process.stdout.write('Session auto-saved to Railway ✅\n');
    }
  } catch (e) {
    process.stdout.write('saveSessionToEnv error: ' + e.message + '\n');
  }
};

// ── HELPERS ──────────────────────────────────────────────────

// Strip device suffix so @s.whatsapp.net and @lid JIDs can be compared.
const normaliseJid = (jid) => {
  if (!jid) return '';
  return jid.replace(/:.*@/, '@').toLowerCase();
};

const isAdmin = async (sock, gid, uid) => {
  try {
    const g    = await getCachedMeta(sock, gid);
    const uidN = normaliseJid(uid);
    return g.participants
      .filter(p => p.admin)
      .some(p => normaliseJid(p.id) === uidN);
  } catch { return false; }
};

const isBotAdmin = async (sock, gid, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const g      = await getCachedMeta(sock, gid);
      const botJid = normaliseJid(sock.user.id);
      const botLid = sock.user.lid ? normaliseJid(sock.user.lid) : null;
      return g.participants
        .filter(p => p.admin)
        .some(p => {
          const pid = normaliseJid(p.id);
          return pid === botJid || (botLid && pid === botLid);
        });
    } catch (e) {
      process.stdout.write('isBotAdmin attempt ' + (i + 1) + ' failed: ' + e.message + '\n');
      if (i < retries - 1) {
        invalidateCache(gid); // force a fresh fetch on retry
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  return false;
};

const sendMsg = async (sock, jid, text, mentions) => {
  try {
    await sock.sendMessage(jid, { text, ...(mentions && { mentions }) });
  } catch (e) {
    process.stdout.write('sendMsg error: ' + e.message + '\n');
  }
};

const deleteMsg = async (sock, jid, msg) => {
  try {
    await sock.sendMessage(jid, {
      delete: {
        remoteJid:   jid,
        fromMe:      false,
        id:          msg.key.id,
        participant: msg.key.participant
      }
    });
  } catch (_) {}
};

const getLinks = (text) =>
  text.match(/(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi) || [];

const hasPornLink = (text) => {
  const links = getLinks(text);
  return links.some(link =>
    PORN_DOMAINS.some(d => link.toLowerCase().includes(d))
  );
};

const isSpam = (uid) => {
  const now = Date.now();
  if (!spamTracker[uid]) spamTracker[uid] = [];
  spamTracker[uid] = spamTracker[uid].filter(t => now - t < CONFIG.spamWindow);
  spamTracker[uid].push(now);
  return spamTracker[uid].length >= CONFIG.spamLimit;
};

const askAI = async (q) => {
  if (!groq) return '❌ GROQ_API_KEY not set.';
  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: 'user', content: q }],
      model:    'llama3-70b-8192'
    });
    return r.choices[0]?.message?.content || 'No response';
  } catch (e) {
    return 'AI error: ' + e.message;
  }
};

// ── CELEBRATIONS ─────────────────────────────────────────────

const setupCelebrations = (sock, gid) => {
  if (celebDone.has(gid)) return;
  celebDone.add(gid);

  cron.schedule('0 0 1 1 *', async () => {
    await sendMsg(sock, gid, '🎆 *HAPPY NEW YEAR!* 🎆\n\nWishing everyone an amazing New Year! 🥂✨');
  }, { timezone: CONFIG.timezone });

  cron.schedule('0 0 25 12 *', async () => {
    await sendMsg(sock, gid, '🎄 *MERRY CHRISTMAS!* 🎄\n\nWishing you joy and blessings! 🎁⭐');
  }, { timezone: CONFIG.timezone });

  cron.schedule('0 8 * * *', async () => {
    const now = new Date();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    if (m === 10 && d === 20) await sendMsg(sock, gid, '🇰🇪 *HAPPY MASHUJAA DAY!* 🇰🇪\n\nHonoring our heroes! 🦁⚔️');
    if (m === 6  && d === 1)  await sendMsg(sock, gid, '🇰🇪 *HAPPY MADARAKA DAY!* 🇰🇪\n\nTujivunie kuwa Wakenya! 🕊️');
    if (m === 12 && d === 12) await sendMsg(sock, gid, '🇰🇪 *HAPPY JAMHURI DAY!* 🇰🇪\n\nProud to be Kenyan! 🎉');
    if (m === 5  && d === 1)  await sendMsg(sock, gid, '🇰🇪 *HAPPY LABOUR DAY!* 🇰🇪\n\nHonoring all hardworking Kenyans! 💪');
    if (m === 10 && d === 10) await sendMsg(sock, gid, '🇰🇪 *HAPPY UTAMADUNI DAY!* 🇰🇪\n\nUmoja ni nguvu! 🎭');
    if ((m === 4 && d === 10) || (m === 3 && d === 30))
      await sendMsg(sock, gid, '☪️ *EID MUBARAK!* ☪️\n\nBlessed Eid to all Muslims! 🌙🤲');
    if ((m === 6 && d === 16) || (m === 6 && d === 17))
      await sendMsg(sock, gid, '☪️ *EID UL ADHA MUBARAK!* ☪️\n\nMay Allah accept your sacrifices! 🌙🤲');
    if (m === 11 && d === 1)  await sendMsg(sock, gid, '🪔 *HAPPY DIWALI!* 🪔\n\nFestival of lights! ✨');
  }, { timezone: CONFIG.timezone });
};

// ── COMMANDS ─────────────────────────────────────────────────

const handleCmd = async (sock, msg, text, gid, sender) => {
  const botAdmin = await isBotAdmin(sock, gid);
  if (!botAdmin) return;

  const args      = text.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const cmd       = args.shift().toLowerCase();
  const rest      = args.join(' ');
  const admin     = await isAdmin(sock, gid, sender);
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

  process.stdout.write('[CMD] cmd=' + cmd + ' sender=' + sender + '\n');

  switch (cmd) {

    case 'menu':
      await sendMsg(sock, gid,
`╔══════════════════════╗
║     🤖 BOT MENU      ║
╚══════════════════════╝

👮 *ADMIN*
!kick !ban !warn @user
!mute / !unmute
!tagall [msg]
!approve / !unapprove @user
!rules  !poll Q? A,B

🤖 *AI*
!ai [question]
!roast @user
!ship @u1 @u2

😂 *FUN*
!joke  !quote  !fact  !8ball [q]

🛠️ *UTILITY*
!weather [city]
!crypto
!translate [lang] [text]
!calculate [expr]
!remind [mins] [msg]
!news
!time

🎵 *MEDIA*
!song / !video [name]
!tiktok [url]
!lyrics [song]

🛡️ *AUTO-MOD*
Anti-spam | Anti-link (max ${CONFIG.maxLinks})
Porn filter | Invite gate (add ${CONFIG.inviteGate})`);
      break;

    case 'ai':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !ai your question');
      await sendMsg(sock, gid, '🤖 Thinking...');
      await sendMsg(sock, gid, '🤖 *AI:*\n\n' + await askAI(rest));
      break;

    case 'joke':
      try {
        const j  = await axios.get('https://v2.jokeapi.dev/joke/Any?safe-mode');
        const jd = j.data;
        await sendMsg(sock, gid, jd.type === 'single' ? jd.joke : jd.setup + '\n\n😂 ' + jd.delivery);
      } catch { await sendMsg(sock, gid, '😂 Why did the bot crash? Too many requests!'); }
      break;

    case 'quote':
      try {
        const q = await axios.get('https://api.quotable.io/random');
        await sendMsg(sock, gid, '💭 "' + q.data.content + '"\n\n— ' + q.data.author);
      } catch { await sendMsg(sock, gid, '💭 Keep going, you are doing great!'); }
      break;

    case 'fact':
      try {
        const f = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
        await sendMsg(sock, gid, '🧠 ' + f.data.text);
      } catch { await sendMsg(sock, gid, '🧠 Honey bees can recognize human faces!'); }
      break;

    case '8ball': {
      const pool = ['Yes!','No!','Maybe...','Definitely!','Not a chance!','Ask again later','Without a doubt!','Very doubtful'];
      await sendMsg(sock, gid, '🎱 ' + pool[Math.floor(Math.random() * pool.length)]);
      break;
    }

    case 'calculate':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !calculate 2+2');
      try {
        const result = eval(rest.replace(/[^0-9+\-*/.()%]/g, ''));
        await sendMsg(sock, gid, '🧮 ' + rest + ' = *' + result + '*');
      } catch { await sendMsg(sock, gid, '❌ Invalid expression'); }
      break;

    case 'time':
      await sendMsg(sock, gid, '🕐 Kenya time: ' + new Date().toLocaleString('en-KE', { timeZone: CONFIG.timezone }));
      break;

    case 'weather':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !weather Nairobi');
      try {
        const w = await axios.get('https://wttr.in/' + encodeURIComponent(rest) + '?format=3');
        await sendMsg(sock, gid, '🌤️ ' + w.data);
      } catch { await sendMsg(sock, gid, '❌ Could not fetch weather'); }
      break;

    case 'crypto':
      try {
        const c = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd');
        const d = c.data;
        await sendMsg(sock, gid,
          '💰 *Crypto Prices*\n\n' +
          '₿ BTC: $' + d.bitcoin.usd.toLocaleString() + '\n' +
          'Ξ ETH: $' + d.ethereum.usd.toLocaleString() + '\n' +
          '◎ SOL: $' + d.solana.usd.toLocaleString());
      } catch { await sendMsg(sock, gid, '❌ Could not fetch prices'); }
      break;

    case 'translate': {
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !translate french Hello');
      const tp = rest.split(' ');
      const tl = tp.shift();
      const tt = tp.join(' ');
      await sendMsg(sock, gid, '🌍 Translating...');
      await sendMsg(sock, gid, '🌍 *' + tl + ':* ' + await askAI('Translate to ' + tl + ': "' + tt + '". Reply with translation only.'));
      break;
    }

    case 'roast':
      if (!mentioned.length) return sendMsg(sock, gid, '❌ Tag someone to roast!');
      await sock.sendMessage(gid, {
        text: '🔥 @' + mentioned[0].split('@')[0] + ' ' +
          await askAI('Give a funny harmless roast for ' + mentioned[0].split('@')[0] + '. Keep it light.'),
        mentions: mentioned
      });
      break;

    case 'ship':
      if (mentioned.length < 2) return sendMsg(sock, gid, '❌ Tag 2 people!');
      {
        const pct = Math.floor(Math.random() * 100) + 1;
        await sock.sendMessage(gid, {
          text: '💕 @' + mentioned[0].split('@')[0] + ' + @' + mentioned[1].split('@')[0] +
            '\n\n❤️ ' + pct + '% compatible!\n\n' +
            (pct > 70 ? '🔥 Perfect match!' : pct > 40 ? '💛 Good potential!' : '💔 Not great...'),
          mentions: mentioned
        });
      }
      break;

    case 'kick':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      if (!mentioned.length) return sendMsg(sock, gid, '❌ Tag someone!');
      await sock.groupParticipantsUpdate(gid, mentioned, 'remove');
      await sendMsg(sock, gid, '✅ Kicked ' + mentioned.length + ' member(s)');
      invalidateCache(gid);
      break;

    case 'ban':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      if (!mentioned.length) return sendMsg(sock, gid, '❌ Tag someone!');
      await sock.groupParticipantsUpdate(gid, mentioned, 'remove');
      await sendMsg(sock, gid, '🚫 Banned ' + mentioned.length + ' member(s)');
      invalidateCache(gid);
      break;

    case 'mute':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      await sock.groupSettingUpdate(gid, 'announcement');
      await sendMsg(sock, gid, '🔇 Group muted! Only admins can send messages.');
      break;

    case 'unmute':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      await sock.groupSettingUpdate(gid, 'not_announcement');
      await sendMsg(sock, gid, '🔊 Group unmuted! Everyone can send messages.');
      break;

    case 'warn': {
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      if (!mentioned.length) return sendMsg(sock, gid, '❌ Tag someone!');
      const wu = mentioned[0];
      if (!warnings[wu]) warnings[wu] = 0;
      warnings[wu]++;
      if (warnings[wu] >= 3) {
        await sock.groupParticipantsUpdate(gid, [wu], 'remove');
        await sock.sendMessage(gid, { text: '🚫 @' + wu.split('@')[0] + ' kicked after 3 warnings!', mentions: [wu] });
        warnings[wu] = 0;
        invalidateCache(gid);
      } else {
        await sock.sendMessage(gid, { text: '⚠️ Warning ' + warnings[wu] + '/3 for @' + wu.split('@')[0], mentions: [wu] });
      }
      break;
    }

    case 'approve':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      if (!mentioned.length) return sendMsg(sock, gid, '❌ Tag someone!');
      for (const u of mentioned) { approvedUsers.add(u); inviteCount[u] = CONFIG.inviteGate; }
      await sock.sendMessage(gid, {
        text: '✅ Approved ' + mentioned.map(u => '@' + u.split('@')[0]).join(', ') + ' to chat!',
        mentions: mentioned
      });
      break;

    case 'unapprove':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      if (!mentioned.length) return sendMsg(sock, gid, '❌ Tag someone!');
      for (const u of mentioned) { approvedUsers.delete(u); inviteCount[u] = 0; }
      await sock.sendMessage(gid, {
        text: '❌ Unapproved ' + mentioned.map(u => '@' + u.split('@')[0]).join(', '),
        mentions: mentioned
      });
      break;

    case 'tagall':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      try {
        const grp = await getCachedMeta(sock, gid);
        const mbs = grp.participants.map(p => p.id);
        await sock.sendMessage(gid, {
          text: '📢 ' + (rest || 'Attention everyone!') + '\n\n' + mbs.map(m => '@' + m.split('@')[0]).join(' '),
          mentions: mbs
        });
      } catch { await sendMsg(sock, gid, '❌ Error tagging all'); }
      break;

    case 'rules':
      await sendMsg(sock, gid,
`📜 *GROUP RULES*

1. Be respectful to all members
2. No spamming
3. No excessive links (max ${CONFIG.maxLinks})
4. New members must add ${CONFIG.inviteGate} people before chatting
5. No hate speech
6. No pornographic content 🔞
7. Admins have the final say

⚠️ Violations = warnings then kick!`);
      break;

    case 'poll': {
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !poll Question? Option1, Option2');
      const pp = rest.split('?');
      const po = pp[1] ? pp[1].split(',').map(o => o.trim()) : ['Yes', 'No'];
      await sock.sendMessage(gid, { poll: { name: pp[0] + '?', values: po, selectableCount: 1 } });
      break;
    }

    case 'news':
      await sendMsg(sock, gid, '📰 *Latest News*\n\n' +
        await askAI('Give me 5 latest world news headlines today in brief. Number them.'));
      break;

    case 'remind': {
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !remind 5 take medicine');
      const rp = rest.split(' ');
      const rm = parseInt(rp.shift());
      const rt = rp.join(' ');
      if (isNaN(rm)) return sendMsg(sock, gid, '❌ First must be minutes. !remind 5 message');
      await sendMsg(sock, gid, '⏰ Reminder set for ' + rm + ' minutes!');
      setTimeout(async () => { await sendMsg(sock, gid, '⏰ *REMINDER:* ' + rt); }, rm * 60000);
      break;
    }

    case 'song':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !song song name');
      await sendMsg(sock, gid, '🎵 Downloading: ' + rest + '...');
      exec('yt-dlp -x --audio-format mp3 --no-playlist -o "/tmp/%(title)s.%(ext)s" "ytsearch1:' + rest + '"', async (err, stdout, stderr) => {
        if (err) {
          process.stdout.write('Song download error: ' + stderr + '\n');
          return sendMsg(sock, gid, '❌ Download failed: ' + (stderr || err.message).slice(0, 100));
        }
        const files = fs.readdirSync('/tmp').filter(f => f.endsWith('.mp3'));
        if (files.length) {
          const file = '/tmp/' + files[files.length - 1];
          await sock.sendMessage(gid, { audio: fs.readFileSync(file), mimetype: 'audio/mpeg' });
          fs.unlinkSync(file);
        } else {
          await sendMsg(sock, gid, '❌ Download finished but file not found');
        }
      });
      break;

    case 'video':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !video video name');
      await sendMsg(sock, gid, '🎬 Downloading: ' + rest + '...');
      exec('yt-dlp -f "best[filesize<50M]" --no-playlist -o "/tmp/%(title)s.%(ext)s" "ytsearch1:' + rest + '"', async (err, stdout, stderr) => {
        if (err) {
          process.stdout.write('Video download error: ' + stderr + '\n');
          return sendMsg(sock, gid, '❌ Download failed: ' + (stderr || err.message).slice(0, 100));
        }
        const files = fs.readdirSync('/tmp').filter(f => f.endsWith('.mp4'));
        if (files.length) {
          const file = '/tmp/' + files[files.length - 1];
          await sock.sendMessage(gid, { video: fs.readFileSync(file), mimetype: 'video/mp4' });
          fs.unlinkSync(file);
        } else {
          await sendMsg(sock, gid, '❌ Download finished but file not found');
        }
      });
      break;

    case 'tiktok':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !tiktok [url]');
      await sendMsg(sock, gid, '⏬ Downloading TikTok...');
      exec('yt-dlp -o "/tmp/tiktok.mp4" "' + rest + '"', async (err) => {
        if (err) return sendMsg(sock, gid, '❌ Download failed');
        if (fs.existsSync('/tmp/tiktok.mp4')) {
          await sock.sendMessage(gid, { video: fs.readFileSync('/tmp/tiktok.mp4'), mimetype: 'video/mp4' });
          fs.unlinkSync('/tmp/tiktok.mp4');
        }
      });
      break;

    case 'lyrics':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !lyrics song name');
      await sendMsg(sock, gid, '🎵 *' + rest + '*\n\n' +
        await askAI('Describe the theme and meaning of the song "' + rest + '". Do not reproduce actual lyrics.'));
      break;

    default:
      // Unknown command — silently ignore
      break;
  }
};

// ── SAFE SESSION DELETE ───────────────────────────────────────
const clearSession = () => {
  try {
    fs.rmSync(CONFIG.sessionDir, { recursive: true, force: true });
    fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
    process.stdout.write('Session cleared.\n');
  } catch (e) {
    process.stdout.write('clearSession error: ' + e.message + '\n');
  }
};

// ── MAIN BOT ─────────────────────────────────────────────────
const startBot = async () => {
  if (isReconnecting) return;
  isReconnecting = true;

  try {
    fs.mkdirSync(CONFIG.sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);
    const { version }          = await fetchLatestBaileysVersion();

    process.stdout.write('Baileys version: ' + version.join('.') + '\n');

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        // warn level suppresses verbose session/key debug output
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'warn' }))
      },
      printQRInTerminal: false,
      logger:            pino({ level: 'warn' }),   // was 'silent' — warn is better for real errors
      browser:           ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory:      false,
      markOnlineOnConnect:  false,
      fireInitQueries:      false,
      // Prevents 'unexpected error in init queries' crash on connect
      getMessage: async () => { return { conversation: '' }; }
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await saveSessionToEnv();
    });

    // ── PAIRING CODE ──────────────────────────────────────────
    if (!state.creds.registered) {
      const rawNumber = (process.env.PAIRING_NUMBER || '254718160377')
        .replace(/[^0-9]/g, '');

      process.stdout.write('Not registered. Requesting pairing code for: ' + rawNumber + '\n');

      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(rawNumber);
          if (!code) throw new Error('Received empty pairing code');
          const formatted = String(code).match(/.{1,4}/g).join('-');
          process.stdout.write('\n==============================\n');
          process.stdout.write('PAIRING CODE: ' + formatted + '\n');
          process.stdout.write('==============================\n');
          process.stdout.write('WhatsApp > Linked Devices > Link a Device > Link with phone number\n\n');
        } catch (e) {
          process.stdout.write('Pairing code error: ' + e.message + '\n');
          process.stdout.write('Will retry on next restart.\n');
        }
      }, 3000);
    }

    // ── CONNECTION UPDATES ────────────────────────────────────
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      isReconnecting = false;

      if (connection === 'open') {
        process.stdout.write('✅ Bot connected to WhatsApp!\n');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        process.stdout.write('Connection closed. Code: ' + statusCode + '\n');

        if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
          process.stdout.write('Session invalid. Clearing and restarting...\n');
          clearSession();
          setTimeout(startBot, 5000);
        } else {
          process.stdout.write('Reconnecting in 5 seconds...\n');
          setTimeout(startBot, 5000);
        }
      }
    });

    // ── NEW MEMBERS ───────────────────────────────────────────
    sock.ev.on('group-participants.update', async ({ id, participants, action, author }) => {
      // Invalidate cache whenever membership changes
      invalidateCache(id);

      if (action !== 'add') return;

      const botAdmin = await isBotAdmin(sock, id);
      if (!botAdmin) return;

      // Credit whoever added the members toward their invite gate count
      if (author) {
        if (!inviteCount[author]) inviteCount[author] = 0;
        inviteCount[author] += participants.length;

        if (inviteCount[author] >= CONFIG.inviteGate && !approvedUsers.has(author)) {
          approvedUsers.add(author);
          await sendMsg(sock, id,
            '✅ @' + author.split('@')[0] + ' has added ' + inviteCount[author] +
            ' members and is now approved to chat! 🎉',
            [author]
          );
        }
      }

      // Welcome each new member — no gate instructions yet.
      // The gate reminder only fires the first time they actually send a message.
      for (const p of participants) {
        inviteCount[p] = inviteCount[p] || 0;
        await sendMsg(sock, id,
          '👋 Welcome @' + p.split('@')[0] + '! Glad to have you here. 🎉',
          [p]
        );
      }
    });

    // ── MESSAGES ─────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe) continue;

          const gid = msg.key.remoteJid;
          if (!gid || !gid.endsWith('@g.us')) continue;

          const sender = msg.key.participant;
          if (!sender) continue;

          // Extract text from common message types
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption || '';

          const botAdmin = await isBotAdmin(sock, gid);

          process.stdout.write(
            '[MSG] gid=' + gid + ' sender=' + sender +
            ' botAdmin=' + botAdmin + ' text=' + (text || '[no text]') + '\n'
          );

          // Bot must be admin to do anything
          if (!botAdmin) continue;

          const admin = await isAdmin(sock, gid, sender);

          // ── Porn filter ──
          if (text && hasPornLink(text)) {
            await deleteMsg(sock, gid, msg);
            if (!warnings[sender]) warnings[sender] = 0;
            warnings[sender]++;
            if (warnings[sender] >= 3) {
              await sock.groupParticipantsUpdate(gid, [sender], 'remove');
              await sock.sendMessage(gid, {
                text: '🚫 @' + sender.split('@')[0] + ' kicked for sharing adult content!',
                mentions: [sender]
              });
              warnings[sender] = 0;
              invalidateCache(gid);
            } else {
              await sock.sendMessage(gid, {
                text: '🔞 @' + sender.split('@')[0] + ' adult content not allowed! Warning ' + warnings[sender] + '/3',
                mentions: [sender]
              });
            }
            continue;
          }

          // ── Invite gate ──
          // Only enforce if the sender actually sent a text message.
          // Skipping media-only messages prevents the bot spamming the gate
          // reminder every time someone shares a photo/sticker/voice note.
          if (text && !admin && !approvedUsers.has(sender)) {
            const cnt = inviteCount[sender] || 0;
            if (cnt < CONFIG.inviteGate) {
              await deleteMsg(sock, gid, msg);
              await sendMsg(sock, gid,
                '⛔ @' + sender.split('@')[0] +
                ' add *' + (CONFIG.inviteGate - cnt) +
                ' more members* before chatting! (' + cnt + '/' + CONFIG.inviteGate + ')',
                [sender]
              );
              continue;
            } else {
              approvedUsers.add(sender);
            }
          }

          // ── Anti-spam ── (only for text messages)
          if (text && !admin && isSpam(sender)) {
            await deleteMsg(sock, gid, msg);
            await sendMsg(sock, gid, '⚠️ @' + sender.split('@')[0] + ' stop spamming!', [sender]);
            continue;
          }

          // ── Anti-link ── (only for text messages)
          if (text && !admin && getLinks(text).length > CONFIG.maxLinks) {
            await deleteMsg(sock, gid, msg);
            await sendMsg(sock, gid, '🚫 @' + sender.split('@')[0] + ' too many links! Message deleted.', [sender]);
            continue;
          }

          // ── Commands ──
          if (text && text.startsWith(CONFIG.prefix)) {
            await handleCmd(sock, msg, text, gid, sender);
          }

          // Register celebrations for this group (runs once per gid)
          setupCelebrations(sock, gid);

        } catch (e) {
          process.stdout.write('Message handler error: ' + e.stack + '\n');
        }
      }
    });

  } catch (e) {
    isReconnecting = false;
    process.stdout.write('startBot error: ' + e.stack + '\n');
    process.stdout.write('Restarting in 10 seconds...\n');
    setTimeout(startBot, 10000);
  }
};

// ── CRASH RECOVERY ───────────────────────────────────────────
process.on('uncaughtException', err => {
  process.stdout.write('UNCAUGHT EXCEPTION: ' + err.stack + '\n');
});

process.on('unhandledRejection', err => {
  process.stdout.write('UNHANDLED REJECTION: ' + (err?.stack || err) + '\n');
});

// ── HTTP KEEPALIVE (prevents Railway SIGTERM) ────────────────
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(process.env.PORT || 3000, () => {
  process.stdout.write('HTTP server listening on port ' + (process.env.PORT || 3000) + '\n');
});

// ── START ────────────────────────────────────────────────────
startBot();
