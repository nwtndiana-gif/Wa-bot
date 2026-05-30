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
  prefix:      '!',
  inviteGate:  2,
  maxLinks:    2,
  spamLimit:   5,
  spamWindow:  10000,
  timezone:    'Africa/Nairobi',
  sessionDir:  './session'
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

// ── SESSION DIRECTORY ────────────────────────────────────────
try {
  fs.mkdirSync(CONFIG.sessionDir, { recursive: true });
  process.stdout.write('Session directory ready: ' + CONFIG.sessionDir + '\n');
} catch (e) {
  process.stdout.write('Could not create session dir: ' + e.message + '\n');
}

// ── JID NORMALISATION ────────────────────────────────────────
// WhatsApp now uses @lid (Linked ID) format in addition to @s.whatsapp.net.
// Strip the device suffix and keep only number@domain so comparisons work
// across both formats.
const normaliseJid = (jid) => {
  if (!jid) return '';
  return jid.replace(/:.*@/, '@');   // "1234:5@s.whatsapp.net" → "1234@s.whatsapp.net"
};

// ── HELPERS ──────────────────────────────────────────────────

/**
 * Check whether `uid` is an admin of group `gid`.
 * Works for both @s.whatsapp.net and @lid JIDs.
 */
const isAdmin = async (sock, gid, uid) => {
  try {
    const g = await sock.groupMetadata(gid);
    if (!g || !g.participants) return false;
    const uidNorm = normaliseJid(uid);
    return g.participants.some(p => p.admin && normaliseJid(p.id) === uidNorm);
  } catch { return false; }
};

/**
 * Check whether the bot itself is an admin of group `gid`.
 * Compares against both the phone JID and the LID (if present) so the
 * lookup succeeds regardless of which format WhatsApp reports for the bot.
 */
const isBotAdmin = async (sock, gid) => {
  try {
    const g = await sock.groupMetadata(gid);
    if (!g || !g.participants) return false;

    // Normalise the bot's known identities
    const botPhoneNorm = sock.user?.id  ? normaliseJid(sock.user.id)  : null;
    const botLidNorm   = sock.user?.lid ? normaliseJid(sock.user.lid) : null;

    return g.participants.some(p => {
      if (!p.admin) return false;
      const pNorm = normaliseJid(p.id);
      return (botPhoneNorm && pNorm === botPhoneNorm) ||
             (botLidNorm   && pNorm === botLidNorm);
    });
  } catch { return false; }
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
      model:    'llama3-8b-8192'
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

  const args      = text.slice(CONFIG.prefix.length).trim().split(' ');
  const cmd       = args.shift().toLowerCase();
  const rest      = args.join(' ');
  const admin     = await isAdmin(sock, gid, sender);
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

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
      break;

    case 'ban':
      if (!admin) return sendMsg(sock, gid, '❌ Admins only!');
      if (!mentioned.length) return sendMsg(sock, gid, '❌ Tag someone!');
      await sock.groupParticipantsUpdate(gid, mentioned, 'remove');
      await sendMsg(sock, gid, '🚫 Banned ' + mentioned.length + ' member(s)');
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
        const grp = await sock.groupMetadata(gid);
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
      exec('yt-dlp -x --audio-format mp3 -o "/tmp/%(title)s.%(ext)s" "ytsearch1:' + rest + '"', async (err) => {
        if (err) return sendMsg(sock, gid, '❌ Download failed');
        const files = fs.readdirSync('/tmp').filter(f => f.endsWith('.mp3'));
        if (files.length) {
          const file = '/tmp/' + files[files.length - 1];
          await sock.sendMessage(gid, { audio: fs.readFileSync(file), mimetype: 'audio/mpeg' });
          fs.unlinkSync(file);
        }
      });
      break;

    case 'video':
      if (!rest) return sendMsg(sock, gid, '❌ Usage: !video video name');
      await sendMsg(sock, gid, '🎬 Downloading: ' + rest + '...');
      exec('yt-dlp -f "best[filesize<50M]" -o "/tmp/%(title)s.%(ext)s" "ytsearch1:' + rest + '"', async (err) => {
        if (err) return sendMsg(sock, gid, '❌ Download failed');
        const files = fs.readdirSync('/tmp').filter(f => f.endsWith('.mp4'));
        if (files.length) {
          const file = '/tmp/' + files[files.length - 1];
          await sock.sendMessage(gid, { video: fs.readFileSync(file), mimetype: 'video/mp4' });
          fs.unlinkSync(file);
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
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      logger:            pino({ level: 'silent' }),
      browser:           ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory:   false,
      markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

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
          process.stdout.write('WhatsApp Business > Linked Devices > Link a Device > Link with phone number\n\n');
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
        // Log bot JIDs for debugging
        process.stdout.write('Bot phone JID: ' + (sock.user?.id  || 'unknown') + '\n');
        process.stdout.write('Bot LID:       ' + (sock.user?.lid || 'none')    + '\n');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        process.stdout.write('Connection closed. Code: ' + statusCode + '\n');

        if (
          statusCode === DisconnectReason.loggedOut ||
          statusCode === 401
        ) {
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
      if (action !== 'add') return;

      const botAdmin = await isBotAdmin(sock, id);
      if (!botAdmin) return;

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

      for (const p of participants) {
        inviteCount[p] = inviteCount[p] || 0;
        await sendMsg(sock, id,
          '👋 Welcome @' + p.split('@')[0] + '!\n\n' +
          'To unlock chatting you must *add ' + CONFIG.inviteGate +
          ' members* directly to this group first!\n\n' +
          'Type !menu after approval ✅',
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

          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text || '';

          const admin    = await isAdmin(sock, gid, sender);
          const botAdmin = await isBotAdmin(sock, gid);

          process.stdout.write(
            '[MSG] gid=' + gid + ' sender=' + sender +
            ' botAdmin=' + botAdmin + ' text=' + (text || '[no text]') + '\n'
          );

          if (!botAdmin) continue;

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
            } else {
              await sock.sendMessage(gid, {
                text: '🔞 @' + sender.split('@')[0] + ' adult content not allowed! Warning ' + warnings[sender] + '/3',
                mentions: [sender]
              });
            }
            continue;
          }

          // ── Invite gate ──
          if (!admin && !approvedUsers.has(sender)) {
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

          // ── Anti-spam ──
          if (!admin && isSpam(sender)) {
            await deleteMsg(sock, gid, msg);
            await sendMsg(sock, gid, '⚠️ @' + sender.split('@')[0] + ' stop spamming!', [sender]);
            continue;
          }

          // ── Anti-link ──
          if (!admin && text && getLinks(text).length > CONFIG.maxLinks) {
            await deleteMsg(sock, gid, msg);
            await sendMsg(sock, gid, '🚫 @' + sender.split('@')[0] + ' too many links! Message deleted.', [sender]);
            continue;
          }

          // ── Commands ──
          if (text && text.startsWith(CONFIG.prefix)) {
            await handleCmd(sock, msg, text, gid, sender);
          }

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

// ── START ────────────────────────────────────────────────────
startBot();
