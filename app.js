require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const db = require('./db');
const { refreshIfNeeded } = require('./spotifyService');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser('feestje_geheim_123'));
app.use(express.static('public'));

// --- HELPERS ---
const getActiveUser = async (req) => {
    const userToken = req.signedCookies.user_auth;
    if (!userToken) return null;
    try {
        const res = await db.query('SELECT * FROM users WHERE token = $1', [userToken]);
        return res.rows[0] || null;
    } catch (e) { return null; }
};

// --- API ROUTES ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const result = await db.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
    if (result.rows.length > 0) {
        const token = uuidv4();
        await db.query('UPDATE users SET token = $1 WHERE id = $2', [token, result.rows[0].id]);
        res.cookie('user_auth', token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.json({ ok: true });
    } else { res.json({ ok: false }); }
});

app.get('/api/tracks', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();
    const token = await refreshIfNeeded();
    const historyRes = await db.query("SELECT track_id FROM history WHERE username = $1", [user.username]);
    const viewed = new Set(historyRes.rows.map(h => h.track_id));

    const playlist = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}?fields=tracks.total`, { headers: { Authorization: `Bearer ${token}` } });
    const offset = Math.floor(Math.random() * Math.max(0, playlist.data.tracks.total - 50));
    const resp = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}/tracks?limit=50&offset=${offset}`, { headers: { Authorization: `Bearer ${token}` } });

    res.json(resp.data.items.map(i => i.track).filter(t => t && t.id && !viewed.has(t.id)).slice(0, 10));
});

app.post('/api/interact', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();
    const { track_id, action, uri, track_name, artist_name } = req.body;
    await db.query('INSERT INTO history (username, track_id, action, track_name, artist_name) VALUES ($1, $2, $3, $4, $5)', [user.username, track_id, action, track_name, artist_name]);
    if (action === 'like') {
        const token = await refreshIfNeeded();
        await axios.post(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_TARGET_PLAYLIST_ID}/tracks`, { uris: [uri] }, { headers: { Authorization: `Bearer ${token}` } });
    }
    res.json({ ok: true });
});

app.get('/logout', (req, res) => { res.clearCookie('user_auth'); res.redirect('/'); });

// --- HTML FRONTEND ---
app.get('/', async (req, res) => {
    const user = await getActiveUser(req);
    const showSwipe = !!user;

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Tuinfeest Swipe</title>
        <link rel="stylesheet" href="/style.css">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js"></script>
    </head>
    <body>
        <header>
            <h2 style="margin:0">Tuinfeest Swipe 🎶</h2>
            ${showSwipe ? '<a href="/logout" style="color:white; text-decoration:none; font-size:0.8rem">LOGUIT</a>' : ''}
        </header>

        ${!showSwipe ? `
            <div class="login-card">
                <h3>Wie bent u?</h3>
                <input type="text" id="u" placeholder="Naam">
                <input type="password" id="p" placeholder="Wachtwoord">
                <button onclick="doLogin()" class="btn-start">START</button>
                <p id="msg" style="color:#ff6b6b; font-size:0.8rem; margin-top:10px;"></p>
            </div>
        ` : `
            <div class="tinder-container" id="tinderContainer"></div>
            <div class="controls">
                <button class="circle-btn btn-nope" onclick="forceSwipe('left')">✖</button>
                <button class="circle-btn btn-like" onclick="forceSwipe('right')">❤</button>
            </div>
        `}

        <script>
            async function doLogin() {
                const r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username: u.value, password: p.value }) });
                const d = await r.json();
                if (d.ok) location.reload();
                else {
                    const card = document.querySelector('.login-card');
                    card.classList.add('shake');
                    document.getElementById('msg').innerText = "Onjuiste gegevens!";
                    setTimeout(() => card.classList.remove('shake'), 400);
                }
            }

            let tracks = []; let idx = 0;
            async function load() {
                const r = await fetch('/api/tracks');
                const d = await r.json();
                tracks = [...tracks, ...d];
                if (idx === 0 && tracks.length > 0) render();
            }

            function render() {
                const cont = document.getElementById('tinderContainer');
                if (idx >= tracks.length - 2) load();
                const t = tracks[idx];
                if (!t) return;
                cont.innerHTML = \`
                    <div class="track-card" id="card">
                        <div class="stamp stamp-like">LIKE</div>
                        <div class="stamp stamp-nope">NOPE</div>
                        <iframe src="https://open.spotify.com/embed/track/\${t.id}" width="100%" height="380" frameborder="0" allow="encrypted-media"></iframe>
                        <div class="swipe-zone"></div>
                    </div>\`;
                
                const el = document.getElementById('card');
                const hammer = new Hammer(el.querySelector('.swipe-zone'));
                const sL = el.querySelector('.stamp-like');
                const sN = el.querySelector('.stamp-nope');

                hammer.on('pan', (ev) => {
                    const x = ev.deltaX;
                    const op = Math.min(Math.abs(x) / 150, 1);
                    el.style.transform = 'translateX(calc(-50% + ' + x + 'px)) rotate(' + (x/15) + 'deg)';
                    if (x > 0) { el.style.background = 'rgba(29, 185, 84,'+(op*0.7)+')'; sL.style.opacity = op; sN.style.opacity = 0; }
                    else { el.style.background = 'rgba(255,107,107,'+(op*0.7)+')'; sN.style.opacity = op; sL.style.opacity = 0; }
                });

                hammer.on('panend', (ev) => {
                    if (Math.abs(ev.deltaX) > 150) forceSwipe(ev.deltaX > 0 ? 'right' : 'left');
                    else { 
                        el.style.transition = '0.3s';
                        el.style.transform = 'translateX(-50%)'; el.style.background = '#222'; 
                        sL.style.opacity = 0; sN.style.opacity = 0;
                        setTimeout(() => el.style.transition = '', 300);
                    }
                });
            }

            function forceSwipe(dir) {
                const el = document.getElementById('card');
                if (!el) return;
                el.style.transition = '0.4s ease-out';
                el.style.transform = dir === 'right' ? 'translateX(250%) rotate(30deg)' : 'translateX(-250%) rotate(-30deg)';
                const t = tracks[idx];
                fetch('/api/interact', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ track_id: t.id, action: dir==='right'?'like':'nope', uri: t.uri, track_name: t.name, artist_name: t.artists[0].name }) });
                setTimeout(() => { idx++; render(); }, 350);
            }
            if (document.getElementById('tinderContainer')) load();
        </script>
    </body>
    </html>
    `);
});

app.listen(port, () => console.log('Server live op ' + port));