require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const bcrypt = require('bcrypt');
const db = require('./db');
const { refreshIfNeeded } = require('./spotifyService');

const app = express();
const port = process.env.PORT || 3000;
const saltRounds = 10;

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

async function getArtistGenres(artistId, token) {
    try {
        const res = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return res.data.genres; 
    } catch (e) { return []; }
}

// --- API ROUTES ---

app.get('/api/tracks', async (req, res) => {
    const user = await getActiveUser(req);
    const forceRefresh = req.query.refresh === 'true';
    if (!user) return res.status(401).send();

    try {
        const token = await refreshIfNeeded();
        const historyRes = await db.query("SELECT track_id, action, genres FROM history WHERE (username = $1 OR track_id = 'BAN_ARTIST')", [user.username]);
        const history = historyRes.rows || [];
        const viewed = new Set(history.filter(h => h.username === user.username).map(h => h.track_id));
        const artistBans = new Set(history.filter(h => h.track_id === 'BAN_ARTIST').map(h => h.action.toLowerCase()));
        
        const playlistInfo = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}?fields=tracks.total`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const totalTracks = playlistInfo.data.tracks.total;
        let offset = Math.floor(Math.random() * Math.max(0, totalTracks - 50));

        const resp = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}/tracks?limit=50&offset=${offset}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        let candidates = resp.data.items.map(i => i.track).filter(t => t && t.id && !viewed.has(t.id) && !artistBans.has(t.artists[0].name.toLowerCase()));

        // Genre Algoritme Ranking
        const genreScores = {};
        history.filter(h => h.action === 'like' && h.username === user.username).forEach(h => {
            if (h.genres) h.genres.split(',').forEach(g => { genreScores[g] = (genreScores[g] || 0) + 1; });
        });

        for (let track of candidates.slice(0, 15)) {
            track.temp_genres = await getArtistGenres(track.artists[0].id, token);
        }

        candidates.sort((a, b) => {
            const aScore = (a.temp_genres || []).reduce((acc, g) => acc + (genreScores[g] || 0), 0);
            const bScore = (b.temp_genres || []).reduce((acc, g) => acc + (genreScores[g] || 0), 0);
            return bScore - aScore;
        });

        res.json(candidates.slice(0, 10));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/interact', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();
    const { track_id, action, uri, track_name, artist_name, artist_id } = req.body;
    try {
        const token = await refreshIfNeeded();
        let genresStr = "";
        if (action === 'like') {
            const genres = await getArtistGenres(artist_id, token);
            genresStr = genres.join(',');
            await axios.post(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_TARGET_PLAYLIST_ID}/tracks`, { uris: [uri] }, {
                headers: { Authorization: `Bearer ${token}` }
            });
        }
        await db.query('INSERT INTO history (username, track_id, action, track_name, artist_name, genres) VALUES ($1, $2, $3, $4, $5, $6)', 
            [user.username, track_id, action, track_name, artist_name, genresStr]);
        res.json({ ok: true });
    } catch (e) { res.status(500).send(e.message); }
});

// --- AUTH ---

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.json({ ok: false });
        let isMatch = await bcrypt.compare(password, user.password).catch(() => password === user.password);
        if (isMatch) {
            const token = uuidv4();
            await db.query('UPDATE users SET token = $1 WHERE id = $2', [token, user.id]);
            res.cookie('user_auth', token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
            res.json({ ok: true });
        } else res.json({ ok: false });
    } catch (e) { res.status(500).send("Fout"); }
});

app.get('/logout', (req, res) => { res.clearCookie('user_auth'); res.redirect('/'); });

// --- PAGES ---

app.get('/', async (req, res) => {
    const user = await getActiveUser(req);
    const showSwipe = !!user;
    res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Tuinfeest Swipe</title>
    <link rel="stylesheet" href="/style.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/hammer.js/2.0.8/hammer.min.js"></script>
</head>
<body>
    <div id="toastContainer"></div>
    <header>
        <div class="user-menu">${showSwipe ? '<a href="/dashboard" class="nav-link">MIJN STATS</a>' : ''}</div>
        <h1>Tuinfeest Swipe 🎶</h1>
        <div class="user-menu">${showSwipe ? '<a href="/logout" class="logout-link">LOGUIT</a>' : ''}</div>
    </header>
    <main>
        ${!showSwipe ? `
            <div class="login-card">
                <h2 class="login-header-main">Welkom bij</h2>
                <h1 class="login-header-sub">Tuinfeest</h1>
                <input type="text" id="userInput" placeholder="Naam">
                <input type="password" id="passInput" placeholder="Wachtwoord">
                <button onclick="login()" class="btn-start">START</button>
            </div>
        ` : `
            <div class="tinder-container" id="tinderContainer"></div>
            <div class="controls">
                <button class="circle-btn btn-nope" onclick="handleSwipe('nope')">✖</button>
                <button class="circle-btn btn-like" onclick="handleSwipe('like')">❤</button>
            </div>
        `}
    </main>
    <script>
        function showToast(msg) {
            const container = document.getElementById('toastContainer');
            const t = document.createElement('div'); t.className = 'toast'; t.innerText = msg;
            container.appendChild(t); setTimeout(() => t.remove(), 3000);
        }

        async function login() {
            const username = document.getElementById('userInput').value;
            const password = document.getElementById('passInput').value;
            const r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password }) });
            const d = await r.json(); if (d.ok) location.reload(); else alert("Foutje!");
        }

        ${showSwipe ? `
        let trackList = []; let currentIndex = 0; let isAnimating = false;
        let sLikes = 0; let sNopes = 0;

        async function loadTracks(force = false) {
            const r = await fetch(force ? '/api/tracks?refresh=true' : '/api/tracks');
            const newTracks = await r.json();
            if(force) { trackList = newTracks; currentIndex = 0; } else { trackList = [...trackList, ...newTracks]; }
            if(!document.getElementById('activeCard')) renderCard();
        }

        function renderCard() {
            const container = document.getElementById('tinderContainer');
            if (currentIndex >= trackList.length - 2) loadTracks();
            const t = trackList[currentIndex]; if(!t) return;
            container.innerHTML = \`<div class="track-card" id="activeCard">
                <div class="stamp stamp-nope" id="nopeStamp">NOPE</div>
                <div class="stamp stamp-like" id="likeStamp">LIKE</div>
                <iframe src="https://open.spotify.com/embed/track/\${t.id}" width="100%" height="352" frameborder="0" allow="encrypted-media"></iframe>
                <div class="swipe-zone"></div>
            </div>\`;
            setupHammer();
        }

        async function handleSwipe(action) {
            if (isAnimating) return; isAnimating = true;
            const t = trackList[currentIndex];
            if(action === 'like') { sLikes++; sNopes = 0; if(sLikes === 10) showToast("Lekker bezig! Al 10 tracks toegevoegd! 🔥"); }
            else { sNopes++; sLikes = 0; if(sNopes === 5) { showToast("Moeilijk publiek... 😉 Even wat anders!"); loadTracks(true); } }

            const el = document.getElementById('activeCard');
            const moveX = action === 'like' ? 1000 : -1000;
            el.style.transition = 'transform 0.5s ease-in, opacity 0.5s';
            el.style.transform = 'translate(' + moveX + 'px, 0px) rotate(' + (moveX/10) + 'deg)';
            el.style.opacity = '0';

            fetch('/api/interact', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ 
                track_id: t.id, action, uri: t.uri, track_name: t.name, artist_name: t.artists[0].name, artist_id: t.artists[0].id 
            })});

            setTimeout(() => { currentIndex++; isAnimating = false; renderCard(); }, 500);
        }

        function setupHammer() {
            const el = document.getElementById('activeCard'); if(!el) return;
            const hammer = new Hammer(el.querySelector('.swipe-zone'));
            hammer.on('pan', (ev) => {
                if (isAnimating) return;
                el.style.transform = 'translate(' + ev.deltaX + 'px, ' + ev.deltaY + 'px) rotate(' + (ev.deltaX / 15) + 'deg)';
                const op = Math.min(Math.abs(ev.deltaX) / 150, 1);
                if (ev.deltaX > 0) { document.getElementById('likeStamp').style.opacity = op; document.getElementById('nopeStamp').style.opacity = 0; }
                else { document.getElementById('nopeStamp').style.opacity = op; document.getElementById('likeStamp').style.opacity = 0; }
            });
            hammer.on('panend', (ev) => {
                if (isAnimating) return;
                if (ev.deltaX > 150) handleSwipe('like'); else if (ev.deltaX < -150) handleSwipe('nope');
                else { el.style.transform = ''; document.getElementById('likeStamp').style.opacity = 0; document.getElementById('nopeStamp').style.opacity = 0; }
            });
        }
        loadTracks();` : ''}
    </script>
</body>
</html>`);
});

app.get('/dashboard', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.redirect('/');
    const countRes = await db.query("SELECT action, COUNT(*) as count FROM history WHERE username = $1 GROUP BY action", [user.username]);
    let stats = { likes: 0, nopes: 0 };
    countRes.rows.forEach(r => { if (r.action === 'like') stats.likes = r.count; if (r.action === 'nope') stats.nopes = r.count; });
    const artistRes = await db.query("SELECT artist_name, COUNT(*) as count FROM history WHERE username = $1 AND action = 'like' GROUP BY artist_name ORDER BY count DESC LIMIT 5", [user.username]);
    const trackRes = await db.query("SELECT track_name, artist_name FROM history WHERE username = $1 AND action = 'like' ORDER BY id DESC LIMIT 10", [user.username]);

    res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mijn Stats</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <header>
        <div class="user-menu"><a href="/" class="nav-link">SWIPE</a></div>
        <h1>Mijn Stats 📊</h1>
        <div class="user-menu"><a href="/logout" class="logout-link">LOGUIT</a></div>
    </header>
    <main>
        <div class="login-card" style="max-height: 80vh; overflow-y: auto;">
            <h2 class="login-header-main">Lekker bezig, ${user.username}!</h2>
            <div class="stats-row" style="display:flex; justify-content: space-around; margin: 20px 0; border-bottom: 1px solid #eee; padding-bottom: 10px;">
                <div style="text-align:center;"><strong>${stats.likes}</strong><br><small>Likes</small></div>
                <div style="text-align:center;"><strong>${stats.nopes}</strong><br><small>Nopes</small></div>
            </div>
            <div style="text-align:left; margin-bottom: 20px;">
                <h3 style="font-family:'Bebas Neue'; color:#fe8777;">Top 5 Artiesten</h3>
                <ul style="list-style:none; font-size:0.9rem;">
                    ${artistRes.rows.map(a => `<li style="border-bottom:1px solid #f9f9f9; padding:5px 0;">\${a.artist_name} <span style="float:right; color:#888;">\${a.count}x</span></li>`).join('')}
                </ul>
            </div>
            <div style="text-align:left;">
                <h3 style="font-family:'Bebas Neue'; color:#fe8777;">Laatst Geliket</h3>
                <ul style="list-style:none; font-size:0.8rem;">
                    ${trackRes.rows.map(t => `<li style="margin-bottom:8px;"><strong>\${t.track_name}</strong><br>\${t.artist_name}</li>`).join('')}
                </ul>
            </div>
            <button onclick="window.location.href='/'" class="btn-start" style="margin-top:20px;">BACK TO SWIPE</button>
        </div>
    </main>
</body>
</html>`);
});

app.listen(port, () => console.log(`Feest draait op poort ${port}`));
