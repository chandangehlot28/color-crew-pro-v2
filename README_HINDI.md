# Chandan's Card Club — Color Crew Pro v2

यह package एक सुंदर, responsive online card-game website और उसके realtime server को साथ रखता है। इसमें room code, player nickname, 6-seat lobby, server-managed game turns, text chat, peer-to-peer voice signaling, सरल Hindi rules, UNO window और disconnect होने पर Digital Friend takeover शामिल हैं।

## सबसे जरूरी बात

**Creator/Chandan को पूरी बाज़ी में online रहना जरूरी नहीं है।** Room और game state server संभालता है। यदि कोई खिलाड़ी lobby छोड़ता है, उसकी seat lobby से हटती है लेकिन room code बना रहता है। Game शुरू होने के बाद कोई player निकलता है तो उसकी seat Digital Friend संभालता है। कोई भी connected player 2 या अधिक वास्तविक players होने पर game start कर सकता है।

कमरे server की memory में रखे जाते हैं। यदि backend server restart/redeploy हो जाए तो active rooms समाप्त हो सकते हैं। हमेशा मौजूद रहने वाले rooms के लिए persistent database/Redis जोड़ना अगला production step होगा।

## इस project में क्या है?
- `public/index.html` — redesigned responsive website.
- `public/config.js` — existing Netlify site में backend URL सेट करने के लिए एक line.
- `server.js` — Node + Socket.IO realtime room/game server.
- `render.yaml` — Render deployment blueprint.
- `public/manifest.webmanifest` और `public/service-worker.js` — installable web-app support.

## Deployment का आसान तरीका (पहले Render, फिर वही Netlify link)

### A. Realtime server publish करें
1. इस ZIP को download करके extract करें।
2. पूरा project GitHub repository में upload करें (root में `package.json`, `server.js`, `render.yaml`, `public/` रहने चाहिए)।
3. Render Dashboard में **New + → Web Service** खोलें और उस GitHub repository को connect करें।
4. Build command `npm install`, Start command `npm start` रखें (Render Blueprint भी यही settings ले सकता है)।
5. Deploy complete होने पर Render URL मिलेगा, जैसे `https://chandan-card-club.onrender.com`। `/healthz` खोलने पर `{"ok":true,...}` आना चाहिए।
6. यह URL save कर लें।

### B. मौजूदा Netlify URL को नए server से जोड़ें
1. `netlify-frontend.zip` से website files लें।
2. `config.js` खोलें और `SERVER_URL: ""` को अपने Render URL से बदलें, जैसे `SERVER_URL: "https://chandan-card-club.onrender.com"`। URL के आखिर में slash न लगाएँ।
3. Netlify में अपनी **पुरानी site** खोलें और उसी site के Deploys/Netlify Drop upload flow से इस ZIP की **फाइलें/folder** publish करें। Existing Netlify project पर deploy करने से वही Netlify link बना रहता है।
4. Website खोलें; ऊपर status `ONLINE` दिखना चाहिए।

**Render URL frontend में सेट करने से पहले Netlify frontend पर online rooms काम नहीं करेंगे।** मौजूदा live site को इस package ने अपने आप update नहीं किया है; upload के बाद ही नया appearance/live code दिखाई देगा.

## Game behavior
- 2–6 players per room.
- Players can choose a nickname; branding/owner label stays **Chandan**.
- Any connected player can start the game when at least 2 human players are online.
- Room creator can leave; remaining players keep playing.
- During a round, leaving/disconnecting players become bot-controlled seats after a short reconnect grace period.
- Game state and legal card actions are validated on the server, not by the room creator's browser.
- Wild +4 is rejected when a matching current-colour card remains in the player's hand.
- UNO call window: player has 3 seconds to call UNO; another player can catch them; missed UNO draws 2 cards.
- Text chat broadcasts to the room, up to 220 characters.
- Voice audio is WebRTC peer-to-peer; Socket.IO relays signaling only. No audio is recorded by this app. STUN is configured, but restrictive networks may require TURN relay credentials for dependable voice.

## Important limits
- Room data is in server memory. Server restart/deploy/sleep can clear rooms. Do not promise 24/7 room persistence until persistent storage is configured.
- Render free services may sleep when idle, which may delay new connections and can clear in-memory rooms after a restart. Keep friends connected for a live session, or choose an always-on server plus persistent store for production.
- This has not been production load-tested. Test 2–6 devices, disconnect/reconnect, voice on Wi‑Fi and mobile data, and gameplay edge cases before relying on it for a public audience.
- This is an original UNO-inspired prototype and is not an official UNO product.
