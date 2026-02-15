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

// Helper om de huidige ingelogde gebruiker te vinden
const getActiveUser = async (req) => {
    const userToken = req.signedCookies.user_auth;
    if (!userToken) return null;
    try {
        const res = await db.query('SELECT * FROM users WHERE token = $1', [userToken]);
        return res.rows[0] || null;
    } catch (e) {
        return null;
    }
};

// Helper om genres van een artiest op te halen via Spotify
async function getArtistGenres(artistId, token) {
    try {
        const res = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        return res.data.genres; 
    } catch (e) {
        return [];
    }
}

// API: Tracks ophalen met Genre-Algoritme
app.get('/api/tracks', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();
    try {
        const token = await refreshIfNeeded();
        
        const historyRes = await db.query("SELECT track_id, action, genres FROM history WHERE (username = $1 OR track_id = 'BAN_ARTIST')", [user.username]);
        const history = historyRes.rows || [];
        
        const viewed = new Set(history.filter(h => h.username === user.username).map(h => h.track_id));
        const artistBans = new Set(history.filter(h => h.track_id === 'BAN_ARTIST').map(h => h.action.toLowerCase()));
        
        const genreScores = {};
        history.filter(h => h.action === 'like' && h.username === user.username).forEach(h => {
            if (h.genres) {
                h.genres.split(',').forEach(g => {
                    genreScores[g] = (genreScores[g] || 0) + 1;
                });
            }
        });

        const playlistInfo = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}?fields=tracks.total`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const totalTracks = playlistInfo.data.tracks.total;
        const offset = Math.floor(Math.random() * Math.max(0, totalTracks - 50));

        const resp = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}/tracks?limit=50&offset=${offset}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        let candidates = resp.data.items.map(i => i.track).filter(t => t && t.id && !viewed.has(t.id) && !artistBans.has(t.artists[0].name.toLowerCase()));

        for (let track of candidates.slice(0, 15)) {
            track.temp_genres = await getArtistGenres(track.artists[0].id, token);
        }

        candidates.sort((a, b) => {
            const aScore = (a.temp_genres || []).reduce((acc, g) => acc + (genreScores[g] || 0), 0);
            const bScore = (b.temp_genres || []).reduce((acc, g) => acc + (genreScores[g] || 0), 0);
            return bScore - aScore;
        });

        res.json(candidates.slice(0, 10));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// API: Interactie (Like/Nope)
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
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// API: Login met Hashing
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.json({ ok: false });

        let isMatch = false;
        const isAlreadyHashed = user.password.startsWith('$2b$');

        if (!isAlreadyHashed) {
            if (password === user.password) {
                isMatch = true;
                const newHash = await bcrypt.hash(password, saltRounds);
                await db.query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id]);
            }
        } else {
            isMatch = await bcrypt.compare(password, user.password);
        }

        if (isMatch) {
            const token = uuidv4();
            await db.query('UPDATE users SET token = $1 WHERE id = $2', [token, user.id]);
            res.cookie('user_auth', token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
            res.json({ ok: true });
        } else {
            res.json({ ok: false });
        }
    } catch (e) { res.status(500).send("Server fout"); }
});

// API: Reset
app.post('/api/reset-password', async (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.json({ ok: false, msg: "Gebruiker niet gevonden" });
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) return res.json({ ok: false, msg: "Oud wachtwoord onjuist" });
        const newHash = await bcrypt.hash(newPassword, saltRounds);
        await db.query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id]);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, msg: "Server fout" }); }
});

app.get('/logout', (req, res) => {
    res.clearCookie('user_auth');
    res.redirect('/');
});

// Route: Index met Dashboard en Swipe
app.get('/', async (req, res) => {
    const user = await getActiveUser(req);
    const showSwipe = !!user;

    let stats = { likes: 0, nopes: 0 };
    let topArtists = [];
    let recentTracks = [];

    if (user) {
        const countRes = await db.query("SELECT action, COUNT(*) as count FROM history WHERE username = $1 GROUP BY action", [user.username]);
        countRes.rows.forEach(r => { if (r.action === 'like') stats.likes = r.count; if (r.action === 'nope') stats.nopes = r.count; });
        const artistRes = await db.query("SELECT artist_name, COUNT(*) as count FROM history WHERE username = $1 AND action = 'like' GROUP BY artist_name ORDER BY count DESC LIMIT 5", [user.username]);
        topArtists = artistRes.rows;
        const trackRes = await db.query("SELECT track_name, artist_name FROM history WHERE username = $1 AND action = 'like' ORDER BY id DESC LIMIT 10", [user.username]);
        recentTracks = trackRes.rows;
    }

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
    <header>
        <div></div>
        <h1>Tuinfeest Swipe 🎶</h1>
        <div class="user-menu">${showSwipe ? '<a href="/logout" class="logout-link">LOGUIT</a>' : ''}</div>
    </header>
    <main>
        ${!showSwipe ? `
            <div class="login-card" id="loginForm">
                <h2 class="login-header-main">Welkom bij</h2>
                <h1 class="login-header-sub">Tuinfeest</h1>
                <input type="text" id="userInput" placeholder="Naam">
                <div class="password-wrapper">
                    <input type="password" id="passInput" placeholder="Wachtwoord">
                    <span class="toggle-password" onclick="togglePasswordVisibility('passInput')">👁️</span>
                </div>
                <button onclick="login()" class="btn-start">START</button>
                <p id="msg"></p>
                <a href="#" onclick="toggleReset(true)" style="display:block; margin-top:15px; font-size:0.8rem; color:#666; text-decoration:none;">Wachtwoord veranderen?</a>
            </div>

            <div class="login-card" id="resetForm" style="display:none;">
                <h2 class="login-header-main">Wachtwoord</h2>
                <h1 class="login-header-sub">Reset</h1>
                <input type="text" id="resetUser" placeholder="Naam">
                <div class="password-wrapper">
                    <input type="password" id="oldPass" placeholder="Oud Wachtwoord">
                    <span class="toggle-password" onclick="togglePasswordVisibility('oldPass')">👁️</span>
                </div>
                <div class="password-wrapper">
                    <input type="password" id="newPass" placeholder="Nieuw Wachtwoord">
                    <span class="toggle-password" onclick="togglePasswordVisibility('newPass')">👁️</span>
                </div>
                <button onclick="resetPassword()" class="btn-start">UPDATE</button>
                <p id="resetMsg"></p>
                <a href="#" onclick="toggleReset(false)" style="display:block; margin-top:15px; font-size:0.8rem; color:#666; text-decoration:none;">Terug naar login</a>
            </div>
        ` : `
            <div class="dashboard">
                <div class="stats-row">
                    <div class="stat-box"><strong>${stats.likes}</strong><br>Likes</div>
                    <div class="stat-box"><strong>${stats.nopes}</strong><br>Nopes</div>
                </div>
                <div class="info-section">
                    <h3>Top 5 Artiesten</h3>
                    <ul class="stats-list">${topArtists.map(a => `<li>${a.artist_name} <span>(${a.count}x)</span></li>`).join('') || 'Nog geen likes'}</ul>
                </div>
                <div class="info-section">
                    <h3>Recent Geliket</h3>
                    <ul class="stats-list">${recentTracks.map(t => `<li>${t.track_name} - <em>${t.artist_name}</em></li>`).join('') || 'Nog niks'}</ul>
                </div>
            </div>

            <div class="tinder-container" id="tinderContainer"></div>
            <div class="controls">
                <button class="circle-btn btn-nope" onclick="handleSwipe('nope')">✖</button>
                <button class="circle-btn btn-like" onclick="handleSwipe('like')">❤</button>
            </div>
        `}
    </main>
    <script>
        function togglePasswordVisibility(id) {
            const input = document.getElementById(id);
            input.type = input.type === "password" ? "text" : "password";
        }
        function toggleReset(show) {
            document.getElementById('loginForm').style.display = show ? 'none' : 'block';
            document.getElementById('resetForm').style.display = show ? 'block' : 'none';
        }
        async function login() {
            const username = document.getElementById('userInput').value;
            const password = document.getElementById('passInput').value;
            const r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password }) });
            const d = await r.json();
            if (d.ok) location.reload(); else document.getElementById('msg').innerText = "Foutje!";
        }
        async function resetPassword() {
            const username = document.getElementById('resetUser').value;
            const oldPassword = document.getElementById('oldPass').value;
            const newPassword = document.getElementById('newPass').value;
            const r = await fetch('/api/reset-password', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, oldPassword, newPassword }) });
            const d = await r.json();
            if (d.ok) { alert("Gewijzigd!"); toggleReset(false); } else { document.getElementById('resetMsg').innerText = d.msg || "Fout"; }
        }

        ${showSwipe ? `
        let trackList = [];
        let currentIndex = 0;
        let isAnimating = false;

        async function loadTracks() {
            const r = await fetch('/api/tracks');
            const newTracks = await r.json();
            trackList = [...trackList, ...newTracks];
            if(currentIndex === 0 && trackList.length > 0 && !document.getElementById('activeCard')) renderCard();
        }

        function renderCard() {
            const container = document.getElementById('tinderContainer');
            if (currentIndex >= trackList.length - 2) loadTracks();
            const t = trackList[currentIndex];
            if(!t) return;
            container.innerHTML = \`
                <div class="track-card" id="activeCard">
                    <div class="stamp stamp-nope" id="nopeStamp">NOPE</div>
                    <div class="stamp stamp-like" id="likeStamp">LIKE</div>
                    <iframe src="https://open.spotify.com/embed/track/\${t.id}" width="100%" height="352" frameborder="0" allow="encrypted-media"></iframe>
                    <div class="swipe-zone"></div>
                </div>
            \`;
            setupHammer();
        }

        function setupHammer() {
            const el = document.getElementById('activeCard');
            if(!el) return;
            const hammer = new Hammer(el.querySelector('.swipe-zone'));
            const likeStamp = document.getElementById('likeStamp');
            const nopeStamp = document.getElementById('nopeStamp');
            hammer.on('pan', (ev) => {
                if (isAnimating) return;
                const rotate = ev.deltaX / 15;
                el.style.transform = 'translate(' + ev.deltaX + 'px, ' + ev.deltaY + 'px) rotate(' + rotate + 'deg)';
                const opacity = Math.min(Math.abs(ev.deltaX) / 150, 1);
                if (ev.deltaX > 0) { likeStamp.style.opacity = opacity; nopeStamp.style.opacity = 0; }
                else { nopeStamp.style.opacity = opacity; likeStamp.style.opacity = 0; }
            });
            hammer.on('panend', (ev) => {
                if (isAnimating) return;
                if (ev.deltaX > 150) handleSwipe('like');
                else if (ev.deltaX < -150) handleSwipe('nope');
                else { el.style.transform = ''; likeStamp.style.opacity = 0; nopeStamp.style.opacity = 0; }
            });
        }

        async function handleSwipe(action) {
            if (isAnimating) return;
            isAnimating = true;
            const el = document.getElementById('activeCard');
            const t = trackList[currentIndex];
            if(!el || !t) return;
            const moveX = action === 'like' ? 1000 : -1000;
            el.style.transition = 'transform 0.5s ease-in, opacity 0.5s';
            el.style.transform = 'translate(' + moveX + 'px, ' + (el.offsetTop) + 'px) rotate(' + (moveX / 10) + 'deg)';
            el.style.opacity = '0';
            
            fetch('/api/interact', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    track_id: t.id, action, uri: t.uri, 
                    track_name: t.name, artist_name: t.artists[0].name,
                    artist_id: t.artists[0].id 
                })
            });
            setTimeout(() => { currentIndex++; isAnimating = false; renderCard(); }, 500);
        }
        loadTracks();
        ` : ''}
    </script>
</body>
</html>`);
});

app.listen(port, () => console.log(`App draait op poort ${port}`));
