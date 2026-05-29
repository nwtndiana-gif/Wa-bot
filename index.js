require('dotenv').config();
const{makeWASocket,useMultiFileAuthState,DisconnectReason,fetchLatestBaileysVersion}=require('@whiskeysockets/baileys');
const pino=require('pino');
const axios=require('axios');
const cron=require('node-cron');
const{exec}=require('child_process');
const fs=require('fs');
const Groq=require('groq-sdk');

const groq=process.env.GROQ_API_KEY?new Groq({apiKey:process.env.GROQ_API_KEY}):null;

const CONFIG={
  prefix:'!',
  inviteGate:2,
  maxLinks:2,
  spamLimit:5,
  spamWindow:10000,
  timezone:'Africa/Nairobi'
};

const PORN_DOMAINS=['pornhub.com','xvideos.com','xnxx.com','xhamster.com','redtube.com','youporn.com','spankbang.com','beeg.com'];

const inviteCount={},warnings={},spamTracker={},approvedUsers=new Set(),celebrationsDone=new Set();

const isAdmin=async(sock,gid,uid)=>{
  try{const g=await sock.groupMetadata(gid);return g.participants.filter(p=>p.admin).map(p=>p.id).includes(uid);}
  catch{return false;}
};

const isBotAdmin=async(sock,gid)=>{
  try{
    const g=await sock.groupMetadata(gid);
    const botId=sock.user.id.replace(/:.*@/,'@');
    return g.participants.filter(p=>p.admin).map(p=>p.id.replace(/:.*@/,'@')).includes(botId);
  }catch{return false;}
};

const sendMsg=async(sock,jid,text,mentions)=>{
  try{await sock.sendMessage(jid,{text,...(mentions&&{mentions})});}
  catch(e){console.log('sendMsg error:',e.message);}
};

const deleteMsg=async(sock,jid,msg)=>{
  try{await sock.sendMessage(jid,{delete:{remoteJid:jid,fromMe:false,id:msg.key.id,participant:msg.key.participant}});}
  catch(e){}
};

const getLinks=(text)=>text.match(/(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi)||[];

const hasPornLink=(text)=>{
  const links=getLinks(text);
  return links.some(link=>PORN_DOMAINS.some(domain=>link.toLowerCase().includes(domain)));
};

const isSpam=(uid)=>{
  const now=Date.now();
  if(!spamTracker[uid])spamTracker[uid]=[];
  spamTracker[uid]=spamTracker[uid].filter(t=>now-t<CONFIG.spamWindow);
  spamTracker[uid].push(now);
  return spamTracker[uid].length>=CONFIG.spamLimit;
};

const askAI=async(q)=>{
  if(!groq)return '❌ GROQ_API_KEY not set.';
  try{
    const r=await groq.chat.completions.create({messages:[{role:'user',content:q}],model:'llama3-8b-8192'});
    return r.choices[0]?.message?.content||'No response';
  }catch(e){return 'AI error: '+e.message;}
};

const setupCelebrations=(sock,gid)=>{
  if(celebrationsDone.has(gid))return;
  celebrationsDone.add(gid);
  cron.schedule('0 0 1 1 *',async()=>{await sendMsg(sock,gid,'🎆 *HAPPY NEW YEAR!* 🎆\n\nWishing everyone an amazing New Year! 🥂✨');},{timezone:CONFIG.timezone});
  cron.schedule('0 0 25 12 *',async()=>{await sendMsg(sock,gid,'🎄 *MERRY CHRISTMAS!* 🎄\n\nWishing you joy and blessings! 🎁⭐');},{timezone:CONFIG.timezone});
  cron.schedule('0 8 * * *',async()=>{
    const now=new Date();const m=now.getMonth()+1;const d=now.getDate();
    if(m===10&&d===20)await sendMsg(sock,gid,'🇰🇪 *HAPPY MASHUJAA DAY!* 🇰🇪\n\nHonoring our heroes! 🦁⚔️');
    if(m===6&&d===1)await sendMsg(sock,gid,'🇰🇪 *HAPPY MADARAKA DAY!* 🇰🇪\n\nTujivunie kuwa Wakenya! 🕊️');
    if(m===12&&d===12)await sendMsg(sock,gid,'🇰🇪 *HAPPY JAMHURI DAY!* 🇰🇪\n\nProud to be Kenyan! 🎉');
    if(m===5&&d===1)await sendMsg(sock,gid,'🇰🇪 *HAPPY LABOUR DAY!* 🇰🇪\n\nHonoring all hardworking Kenyans! 💪');
    if(m===10&&d===10)await sendMsg(sock,gid,'🇰🇪 *HAPPY UTAMADUNI DAY!* 🇰🇪\n\nUmoja ni nguvu! 🎭');
    if((m===4&&d===10)||(m===3&&d===30))await sendMsg(sock,gid,'☪️ *EID MUBARAK!* ☪️\n\nBlessed Eid to all Muslims! 🌙🤲');
    if((m===6&&d===16)||(m===6&&d===17))await sendMsg(sock,gid,'☪️ *EID UL ADHA MUBARAK!* ☪️\n\nMay Allah accept your sacrifices! 🌙🤲');
    if(m===11&&d===1)await sendMsg(sock,gid,'🪔 *HAPPY DIWALI!* 🪔\n\nFestival of lights! ✨');
  },{timezone:CONFIG.timezone});
};

const handleCmd=async(sock,msg,text,gid,sender)=>{
  const botAdmin=await isBotAdmin(sock,gid);
  if(!botAdmin)return;
  const args=text.slice(CONFIG.prefix.length).trim().split(' ');
  const cmd=args.shift().toLowerCase();
  const rest=args.join(' ');
  const admin=await isAdmin(sock,gid,sender);
  const mentioned=msg.message?.extendedTextMessage?.contextInfo?.mentionedJid||[];

  switch(cmd){
    case 'menu':
      await sendMsg(sock,gid,`╔══════════════════════╗\n║     🤖 BOT MENU      ║\n╚══════════════════════╝\n\n👮 *ADMIN COMMANDS*\n!kick @user - Remove from group\n!ban @user - Ban member\n!warn @user - Warn (3 = kick)\n!mute - Lock group\n!unmute - Unlock group\n!tagall [msg] - Tag everyone\n!rules - Show group rules\n!poll Q? Op1, Op2 - Create poll\n!approve @user - Approve user\n!unapprove @user - Unapprove user\n\n🤖 *AI COMMANDS*\n!ai [question] - Ask AI\n!roast @user - Roast someone 🔥\n!ship @u1 @u2 - Compatibility\n\n😂 *FUN*\n!joke !quote !fact !8ball [q]\n\n🛠️ *UTILITY*\n!weather [city]\n!crypto - BTC/ETH/SOL prices\n!translate [lang] [text]\n!calculate [math]\n!remind [mins] [msg]\n!news - Headlines\n!time - Kenya time\n\n🎵 *MEDIA*\n!song [name] - Download MP3\n!video [name] - Download MP4\n!tiktok [url] - Download TikTok\n!lyrics [song] - Song summary\n\n🛡️ *AUTO-MOD (always on)*\n• Anti-spam\n• Anti-link (max ${CONFIG.maxLinks} links)\n• Porn filter 🔞\n• Invite gate (add ${CONFIG.inviteGate} members to chat)`);
      break;

    case 'ai':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !ai your question');
      await sendMsg(sock,gid,'🤖 Thinking...');
      const aiReply=await askAI(rest);
      await sendMsg(sock,gid,'🤖 *AI:*\n\n'+aiReply);
      break;

    case 'joke':
      try{const j=await axios.get('https://v2.jokeapi.dev/joke/Any?safe-mode');const jd=j.data;await sendMsg(sock,gid,jd.type==='single'?jd.joke:jd.setup+'\n\n😂 '+jd.delivery);}
      catch{await sendMsg(sock,gid,'😂 Why did the bot crash? Too many requests!');}
      break;

    case 'quote':
      try{const q=await axios.get('https://api.quotable.io/random');await sendMsg(sock,gid,'💭 "'+q.data.content+'"\n\n— '+q.data.author);}
      catch{await sendMsg(sock,gid,'💭 Keep going, you are doing great!');}
      break;

    case 'fact':
      try{const f=await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');await sendMsg(sock,gid,'🧠 '+f.data.text);}
      catch{await sendMsg(sock,gid,'🧠 Honey bees can recognize human faces!');}
      break;

    case '8ball':
      const ans=['Yes!','No!','Maybe...','Definitely!','Not a chance!','Ask again later','Without a doubt!','Very doubtful'];
      await sendMsg(sock,gid,'🎱 '+ans[Math.floor(Math.random()*ans.length)]);
      break;

    case 'calculate':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !calculate 2+2');
      try{const result=eval(rest.replace(/[^0-9+\-*/.()%]/g,''));await sendMsg(sock,gid,'🧮 '+rest+' = *'+result+'*');}
      catch{await sendMsg(sock,gid,'❌ Invalid calculation');}
      break;

    case 'time':
      await sendMsg(sock,gid,'🕐 Kenya time: '+new Date().toLocaleString('en-KE',{timeZone:CONFIG.timezone}));
      break;

    case 'weather':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !weather Nairobi');
      try{const w=await axios.get('https://wttr.in/'+encodeURIComponent(rest)+'?format=3');await sendMsg(sock,gid,'🌤️ '+w.data);}
      catch{await sendMsg(sock,gid,'❌ Could not fetch weather');}
      break;

    case 'crypto':
      try{
        const c=await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd');
        const d=c.data;
        await sendMsg(sock,gid,'💰 *Crypto Prices*\n\n₿ BTC: $'+d.bitcoin.usd.toLocaleString()+'\nΞ ETH: $'+d.ethereum.usd.toLocaleString()+'\n◎ SOL: $'+d.solana.usd.toLocaleString());
      }catch{await sendMsg(sock,gid,'❌ Could not fetch prices');}
      break;

    case 'translate':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !translate french Hello');
      const tp=rest.split(' ');const tl=tp.shift();const tt=tp.join(' ');
      await sendMsg(sock,gid,'🌍 Translating...');
      const tr=await askAI('Translate to '+tl+': "'+tt+'". Reply with translation only.');
      await sendMsg(sock,gid,'🌍 *'+tl+':* '+tr);
      break;

    case 'roast':
      if(!mentioned.length)return sendMsg(sock,gid,'❌ Tag someone to roast!');
      const roastTarget=mentioned[0].split('@')[0];
      const roast=await askAI('Give a funny harmless roast for '+roastTarget+'. Keep it light.');
      await sock.sendMessage(gid,{text:'🔥 @'+roastTarget+' '+roast,mentions:mentioned});
      break;

    case 'ship':
      if(mentioned.length<2)return sendMsg(sock,gid,'❌ Tag 2 people!');
      const s1=mentioned[0].split('@')[0];const s2=mentioned[1].split('@')[0];
      const sp=Math.floor(Math.random()*100)+1;
      await sock.sendMessage(gid,{text:'💕 @'+s1+' + @'+s2+'\n\n❤️ '+sp+'% compatible!\n\n'+(sp>70?'🔥 Perfect match!':sp>40?'💛 Good potential!':'💔 Not great...'),mentions:mentioned});
      break;

    case 'kick':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      if(!mentioned.length)return sendMsg(sock,gid,'❌ Tag someone!');
      await sock.groupParticipantsUpdate(gid,mentioned,'remove');
      await sendMsg(sock,gid,'✅ Kicked '+mentioned.length+' member(s)');
      break;

    case 'ban':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      if(!mentioned.length)return sendMsg(sock,gid,'❌ Tag someone!');
      await sock.groupParticipantsUpdate(gid,mentioned,'remove');
      await sendMsg(sock,gid,'🚫 Banned '+mentioned.length+' member(s)');
      break;

    case 'mute':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      await sock.groupSettingUpdate(gid,'announcement');
      await sendMsg(sock,gid,'🔇 Group muted! Only admins can send messages.');
      break;

    case 'unmute':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      await sock.groupSettingUpdate(gid,'not_announcement');
      await sendMsg(sock,gid,'🔊 Group unmuted! Everyone can send messages.');
      break;

    case 'warn':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      if(!mentioned.length)return sendMsg(sock,gid,'❌ Tag someone!');
      const wu=mentioned[0];
      if(!warnings[wu])warnings[wu]=0;
      warnings[wu]++;
      if(warnings[wu]>=3){
        await sock.groupParticipantsUpdate(gid,[wu],'remove');
        await sock.sendMessage(gid,{text:'🚫 @'+wu.split('@')[0]+' kicked after 3 warnings!',mentions:[wu]});
        warnings[wu]=0;
      }else{
        await sock.sendMessage(gid,{text:'⚠️ Warning '+warnings[wu]+'/3 for @'+wu.split('@')[0],mentions:[wu]});
      }
      break;

    case 'approve':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      if(!mentioned.length)return sendMsg(sock,gid,'❌ Tag someone!');
      for(const u of mentioned){approvedUsers.add(u);inviteCount[u]=CONFIG.inviteGate;}
      await sock.sendMessage(gid,{text:'✅ Approved '+mentioned.map(u=>'@'+u.split('@')[0]).join(', ')+' to chat!',mentions:mentioned});
      break;

    case 'unapprove':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      if(!mentioned.length)return sendMsg(sock,gid,'❌ Tag someone!');
      for(const u of mentioned){approvedUsers.delete(u);inviteCount[u]=0;}
      await sock.sendMessage(gid,{text:'❌ Unapproved '+mentioned.map(u=>'@'+u.split('@')[0]).join(', '),mentions:mentioned});
      break;

    case 'tagall':
      if(!admin)return sendMsg(sock,gid,'❌ Admins only!');
      try{
        const grp=await sock.groupMetadata(gid);
        const mbs=grp.participants.map(p=>p.id);
        const tags=mbs.map(m=>'@'+m.split('@')[0]).join(' ');
        await sock.sendMessage(gid,{text:'📢 '+(rest||'Attention everyone!')+'\n\n'+tags,mentions:mbs});
      }catch{await sendMsg(sock,gid,'❌ Error tagging all');}
      break;

    case 'rules':
      await sendMsg(sock,gid,`📜 *GROUP RULES*\n\n1. Be respectful to all members\n2. No spamming\n3. No excessive links (max ${CONFIG.maxLinks})\n4. New members must add ${CONFIG.inviteGate} people before chatting\n5. No hate speech\n6. No pornographic content 🔞\n7. Admins have the final say\n\n⚠️ Violations = warnings then kick!`);
      break;

    case 'poll':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !poll Question? Option1, Option2');
      const pp=rest.split('?');const pq=pp[0]+'?';
      const po=pp[1]?pp[1].split(',').map(o=>o.trim()):['Yes','No'];
      await sock.sendMessage(gid,{poll:{name:pq,values:po,selectableCount:1}});
      break;

    case 'news':
      const nr=await askAI('Give me 5 latest world news headlines today in brief. Number them.');
      await sendMsg(sock,gid,'📰 *Latest News*\n\n'+nr);
      break;

    case 'remind':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !remind 5 take medicine');
      const rp=rest.split(' ');const rm=parseInt(rp.shift());const rt=rp.join(' ');
      if(isNaN(rm))return sendMsg(sock,gid,'❌ First must be minutes. !remind 5 message');
      await sendMsg(sock,gid,'⏰ Reminder set for '+rm+' minutes!');
      setTimeout(async()=>{await sendMsg(sock,gid,'⏰ *REMINDER:* '+rt);},rm*60000);
      break;

    case 'song':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !song song name');
      await sendMsg(sock,gid,'🎵 Downloading: '+rest+'...');
      exec('yt-dlp -x --audio-format mp3 -o "/tmp/%(title)s.%(ext)s" "ytsearch1:'+rest+'"',async(err)=>{
        if(err)return sendMsg(sock,gid,'❌ Download failed');
        const files=fs.readdirSync('/tmp').filter(f=>f.endsWith('.mp3'));
        if(files.length){const file='/tmp/'+files[files.length-1];await sock.sendMessage(gid,{audio:fs.readFileSync(file),mimetype:'audio/mpeg'});fs.unlinkSync(file);}
      });
      break;

    case 'video':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !video video name');
      await sendMsg(sock,gid,'🎬 Downloading: '+rest+'...');
      exec('yt-dlp -f "best[filesize<50M]" -o "/tmp/%(title)s.%(ext)s" "ytsearch1:'+rest+'"',async(err)=>{
        if(err)return sendMsg(sock,gid,'❌ Download failed');
        const files=fs.readdirSync('/tmp').filter(f=>f.endsWith('.mp4'));
        if(files.length){const file='/tmp/'+files[files.length-1];await sock.sendMessage(gid,{video:fs.readFileSync(file),mimetype:'video/mp4'});fs.unlinkSync(file);}
      });
      break;

    case 'tiktok':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !tiktok [url]');
      await sendMsg(sock,gid,'⏬ Downloading TikTok...');
      exec('yt-dlp -o "/tmp/tiktok.mp4" "'+rest+'"',async(err)=>{
        if(err)return sendMsg(sock,gid,'❌ Download failed');
        if(fs.existsSync('/tmp/tiktok.mp4')){await sock.sendMessage(gid,{video:fs.readFileSync('/tmp/tiktok.mp4'),mimetype:'video/mp4'});fs.unlinkSync('/tmp/tiktok.mp4');}
      });
      break;

    case 'lyrics':
      if(!rest)return sendMsg(sock,gid,'❌ Usage: !lyrics song name');
      const lr=await askAI('Describe the theme and meaning of the song "'+rest+'". Do not reproduce actual lyrics.');
      await sendMsg(sock,gid,'🎵 *'+rest+'*\n\n'+lr);
      break;
  }
};

const startBot=async()=>{
  const{state,saveCreds}=await useMultiFileAuthState('session');
  const{version}=await fetchLatestBaileysVersion();
  const sock=makeWASocket({version,auth:state,printQRInTerminal:false,logger:pino({level:'silent'}),browser:['WA-Bot','Chrome','1.0.0']});

  sock.ev.on('creds.update',saveCreds);

  const phoneNumber=process.env.PAIRING_NUMBER||'254718160377';
  if(!state.creds.registered){
    setTimeout(async()=>{
      try{
        const code=await sock.requestPairingCode(phoneNumber);
        console.log('\n====================');
        console.log('PAIRING CODE:',code);
        console.log('====================\n');
      }catch(e){console.log('Pairing error:',e.message);}
    },3000);
  }

  sock.ev.on('connection.update',({connection,lastDisconnect})=>{
    if(connection==='close'){
      const code=lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect=code!==DisconnectReason.loggedOut;
      console.log('Connection closed. Code:',code,'| Reconnecting:',shouldReconnect);
      if(shouldReconnect){console.log('Reconnecting in 5 seconds...');setTimeout(startBot,5000);}
    }
    if(connection==='open')console.log('✅ Bot connected to WhatsApp!');
  });

  sock.ev.on('group-participants.update',async({id,participants,action,author})=>{
    if(action==='add'){
      const botAdmin=await isBotAdmin(sock,id);
      if(!botAdmin)return;
      if(author){
        if(!inviteCount[author])inviteCount[author]=0;
        inviteCount[author]+=participants.length;
        if(inviteCount[author]>=CONFIG.inviteGate&&!approvedUsers.has(author)){
          approvedUsers.add(author);
          await sendMsg(sock,id,'✅ @'+author.split('@')[0]+' has added '+inviteCount[author]+' members and is now approved to chat! 🎉',[author]);
        }
      }
      for(const p of participants){
        inviteCount[p]=inviteCount[p]||0;
        await sendMsg(sock,id,'👋 Welcome @'+p.split('@')[0]+'!\n\nTo unlock chatting you must *add '+CONFIG.inviteGate+' members* directly to this group!\n\nType !menu after approval ✅',[p]);
      }
    }
  });

  sock.ev.on('messages.upsert',async({messages})=>{
    for(const msg of messages){
      try{
        if(!msg.message||msg.key.fromMe)continue;
        const gid=msg.key.remoteJid;
        if(!gid||!gid.endsWith('@g.us'))continue;
        const sender=msg.key.participant;
        if(!sender)continue;
        const text=msg.message?.conversation||msg.message?.extendedTextMessage?.text||'';
        const admin=await isAdmin(sock,gid,sender);
        const botAdmin=await isBotAdmin(sock,gid);
        if(!botAdmin)continue;

        if(text&&hasPornLink(text)){
          await deleteMsg(sock,gid,msg);
          if(!warnings[sender])warnings[sender]=0;
          warnings[sender]++;
          if(warnings[sender]>=3){
            await sock.groupParticipantsUpdate(gid,[sender],'remove');
            await sock.sendMessage(gid,{text:'🚫 @'+sender.split('@')[0]+' kicked for sharing adult content!',mentions:[sender]});
            warnings[sender]=0;
          }else{
            await sock.sendMessage(gid,{text:'🔞 @'+sender.split('@')[0]+' adult content not allowed! Warning '+warnings[sender]+'/3',mentions:[sender]});
          }
          continue;
        }

        if(!admin&&!approvedUsers.has(sender)){
          const cnt=inviteCount[sender]||0;
          if(cnt<CONFIG.inviteGate){
            await deleteMsg(sock,gid,msg);
            await sendMsg(sock,gid,'⛔ @'+sender.split('@')[0]+' add *'+(CONFIG.inviteGate-cnt)+' more members* before chatting! ('+cnt+'/'+CONFIG.inviteGate+')',[sender]);
            continue;
          }else{approvedUsers.add(sender);}
        }

        if(!admin&&isSpam(sender)){
          await deleteMsg(sock,gid,msg);
          await sendMsg(sock,gid,'⚠️ @'+sender.split('@')[0]+' stop spamming!',[sender]);
          continue;
        }

        if(!admin&&text&&getLinks(text).length>CONFIG.maxLinks){
          await deleteMsg(sock,gid,msg);
          await sendMsg(sock,gid,'🚫 @'+sender.split('@')[0]+' too many links! Message deleted.',[sender]);
          continue;
        }

        if(text&&text.startsWith(CONFIG.prefix))await handleCmd(sock,msg,text,gid,sender);
        setupCelebrations(sock,gid);

      }catch(e){console.log('Error:',e.message);}
    }
  });
};

process.on('uncaughtException',err=>{console.error('UNCAUGHT:',err);});
process.on('unhandledRejection',err=>{console.error('REJECTION:',err);});

startBot();
