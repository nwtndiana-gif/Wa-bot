# WhatsApp Group Bot

## Setup on Railway

1. Push this code to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variable: GROQ_API_KEY=your_key
4. Deploy
5. Open logs → scan QR code with WhatsApp Business

## Commands
- !menu - Full command list
- !ai [question] - Ask AI
- !kick/!ban/!warn @user - Admin commands
- !mute/!unmute - Lock group
- !tagall [msg] - Tag everyone
- !song/!video/!tiktok - Download media
- !weather/!crypto/!news - Info
- !joke/!quote/!fact/!8ball - Fun
- !translate/!calculate/!remind - Utility
- !rules/!poll - Group tools

## Auto-Moderation
- Anti-spam (5 msgs in 10 seconds)
- Anti-link (max 2 links per message)
- Invite gate (add 5 members before chatting)
