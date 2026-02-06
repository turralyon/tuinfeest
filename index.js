require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Config
const CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
const REDIRECT_URI = (process.env.SPOTIFY_REDIRECT_URI || '').trim();
const SOURCE_PLAYLIST_ID = (process.env.SOURCE_PLAYLIST_ID || '34zbL7XnAE8W1X5e4YNQzW').trim();
const TARGET_PLAYLIST_ID = '2n31vr5fyIbPrKniButEsm'; 

// Geheugen van de server (wordt gereset bij herstart)
let history = []; 
let nopedTrackIds = new Set(); // Slaat IDs op van nummers die naar links zijn geswiped

app.use(express.json());
app.use(express.static('public'));

let accessToken = null;
let refreshToken = null;
let tokenExpiresAt = 0;

// Frontend UI
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="nl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Tuinfeest Swipe 🎶</title>
        <link rel="stylesheet" href="/style.css">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js"></script>
    </head>
    <body>
        <header><h1>Tuinfeest Swipe 🎶</h1></header>
        <div id="status"></div>
        <div class="tinder-container" id="tinder-card-container">
            ${!accessToken ? '<div style="text-align:center;padding-top:50px;"><a href="/login" class="circle-btn like" style="text-decoration:none;width:auto;padding:0 30px;border-radius:50px;">Start Swipen</a></div>' : '<p>Laden...</p>'}
        </div>
        ${accessToken ? '<div class="controls"><button class="circle-btn nope" onclick="handleSwipe(false)">✖</button><button class="circle-btn like" onclick="handleSwipe(true)">❤</button></div>' : ''}

        <script>
            let trackList = [];
            const container = document.getElementById('tinder-card-container');

            async function loadMoreTracks() {
                try {
                    const r = await fetch('/api/tracks');
                    const d = await r.json();
                    trackList = d.tracks;
                    renderCard();
                } catch(e) { container.innerHTML = "<p>Fout bij laden.</p>"; }
            }

            function renderCard() {
                if (trackList.length === 0) { loadMoreTracks(); return; }
                const track = trackList[0];
                container.innerHTML = \`
                    <div class="track-card" id="active-card">
                        <img src="\${track.image}" class="album-art" draggable="false">
                        <div class="track-details">
                            <div><span class="track-name">\${track.name}</span><span class="track-artist">\${track.artist}</span></div>
                            <div style="pointer-events:none;"><iframe src="https://open.spotify.com/embed/track/\${track.id}?theme=0" width="100%" height="80" frameBorder="0"></iframe></div>
                        </div>
                    </div>\`;
                setupHammer();
            }

            function setupHammer() {
                const el = document.getElementById('active-card');
                if(!el) return;
                const hammertime = new Hammer(el);
                hammertime.on('pan', (ev) => {
                    el.style.transition = 'none';
                    el.style.transform = "translate(" + ev.deltaX + "px, " + ev.deltaY + "px) rotate(" + (ev.deltaX / 15) + "deg)";
                });
                hammertime.on('panend', (ev) => {
                    el.style.transition = 'transform 0.3s ease';
                    if (ev.deltaX > 100) handleSwipe(true);
                    else if (ev.deltaX < -100) handleSwipe(false);
                    else el.style.transform = '';
                });
            }

            async function handleSwipe(isLike) {
                const el = document.getElementById('active-card');
                if(!el) return;
                const track = trackList.shift();
                const action = isLike ? 'like' : 'nope';

                el.style.transform = isLike ? 'translate(1000px, 0) rotate(30deg)' : 'translate(-1000px, 0) rotate(-30deg)';
                
                if(isLike) document.getElementById('status').innerText = "✅ Toegevoegd!";
                
                fetch('/api/interact', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ id: track.id, uri: track.uri, name: track.name + " - " + track.artist, action: action })
                });

                setTimeout(() => { document.getElementById('status').innerText = ""; renderCard(); }, 300);
            }
            if(${!!accessToken}) loadMoreTracks();
        </script>
    </body>
    </html>
  `);
});

// Admin Pagina
app.get('/admin', (req, res) => {
    const rows = history.map(h => `<tr><td>${h.time}</td><td>${h.track}</td><td>${h.user}</td><td>${h.action === 'like' ? '✅ Like' : '❌ Nope'}</td></tr>`).join('');
    res.send(`<html><head><title>Admin</title><style>body{font-family:sans-serif;padding:20px;background:#f4f4f4;}table{width:100%;border-collapse:collapse;background:white;}th,td{padding:10px;border:1px solid #ddd;text-align:left;}th{background:#1DB954;color:white;}</style></head>
    <body><h1>Geschiedenis</h1><table><tr><th>Tijd</th><th>Nummer</th><th>IP</th><th>Actie</th></tr>${rows}</table></body></html>`);
});

// API: Verwerk Swipe (Like of Nope)
app.post('/api/interact', async (req, res) => {
    const { id, uri, name, action } = req.body;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress).replace('::ffff:', '');

    if (action === 'like') {
        try {
            await refreshIfNeeded();
            await axios.post(`https://api.spotify.com/v1/playlists/${TARGET_PLAYLIST_ID}/tracks`, { uris: [uri] }, { headers: { Authorization: `Bearer ${accessToken}` } });
        } catch (e) { console.log("Spotify add error"); }
    } else {
        nopedTrackIds.add(id); // Voeg toe aan de "niet meer tonen" lijst
    }

    history.unshift({ time: new Date().toLocaleTimeString('nl-NL'), track: name, user: ip, action: action });
    res.json({ ok: true });
});

// API: Nummers ophalen (gefilterd op dubbelen EN nopes)
app.get('/api/tracks', async (req, res) => {
    try {
        await refreshIfNeeded();
        const target = await axios.get(`https://api.spotify.com/v1/playlists/${TARGET_PLAYLIST_ID}/tracks?fields=items(track(id))`, { headers: { Authorization: `Bearer ${accessToken}` } });
        const existingIds = new Set(target.data.items.map(i => i.track?.id));

        const source = await axios.get(`https://api.spotify.com/v1/playlists/${SOURCE_PLAYLIST_ID}/tracks?limit=100`, { headers: { Authorization: `Bearer ${accessToken}` } });

        const available = source.data.items
            .filter(i => i.track && !existingIds.has(i.track.id) && !nopedTrackIds.has(i.track.id))
            .map(i => ({ id: i.track.id, uri: i.track.uri, name: i.track.name, artist: i.track.artists[0].name, image: i.track.album.images[0]?.url }));

        res.json({ tracks: available.sort(() => 0.5 - Math.random()).slice(0, 10) });
    } catch (e) { res.status(500).json({ error: 'Fout' }); }
});

// Spotify Auth
app.get('/login', (req, res) => {
    const scope = 'playlist-modify-public playlist-modify-private playlist-read-private';
    res.redirect('https://accounts.spotify.com/authorize?' + new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, scope, redirect_uri: REDIRECT_URI }));
});

app.get('/callback', async (req, res) => {
    const r = await axios.post('https://accounts.spotify.com/api/token', new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: REDIRECT_URI }), { headers: { 'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' } });
    accessToken = r.data.access_token; refreshToken = r.data.refresh_token; tokenExpiresAt = Date.now() + (r.data.expires_in * 1000);
    res.redirect('/');
});

async function refreshIfNeeded() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return;
    const r = await axios.post('https://accounts.spotify.com/api/token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), { headers: { 'Authorization': 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64') } });
    accessToken = r.data.access_token; tokenExpiresAt = Date.now() + (r.data.expires_in * 1000);
}

app.listen(port, '0.0.0.0', () => console.log(`Draait op http://192.168.2.7:${port}`));