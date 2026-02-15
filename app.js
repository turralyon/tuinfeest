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

// --- AUTH & RESET ---

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

app.get('/logout', (req, res) => { res.clearCookie('user_auth'); res.redirect('/'); });

// --- SWIPE PAGINA ---

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
            <div id="loginForm" class="login-card">
                <h2 class="login-header-main">Welkom bij</h2>
                <h1 class="login-header-sub">Tuinfeest</h1>
                <input type="text" id="userInput" placeholder="Naam">
                <div class="password-wrapper">
                    <input type="password" id="passInput" placeholder="Wachtwoord">
                    <span class="toggle-password" onclick="togglePasswordVisibility('passInput')">👁️</span>
                </div>
                <button onclick="login()" class="btn-start">START</button>
                <a href="#" onclick="toggleReset(true)" class="small-link" style="display:block; margin-top:15px; font-size:0.8rem; color:#666;">Wachtwoord veranderen?</a>
            </div>

            <div id="resetForm" class="login-card" style="display:none;">
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
                <a href="#" onclick="toggleReset(false)" class="small-link" style="display:block; margin-top:15px; font-size:0.8rem; color:#666;">Terug naar login</a>
                <p id="resetMsg"></p>
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
        function togglePasswordVisibility(id) {
            const input = document.getElementById(id);
            input.type = input.type === "password" ? "text" : "password";
        }
        function toggleReset(show) {
            document.getElementById('loginForm').style.display = show ? 'none' : 'block';
            document.getElementById('resetForm').style.display = show ? 'block' : 'none';
        }
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
        let sLikes = 0; 
        let sNopes = 0;
        let isLoading = false;

        async function loadTracks(force = false) {
            if (isLoading) return;
            isLoading = true;
            
            try {
                const r = await fetch(force ? '/api/tracks?refresh=true' : '/api/tracks');
                const newTracks = await r.json();
                
                if (force) { 
                    trackList = newTracks; 
                    currentIndex = 0; 
                    // Bij een force refresh moeten we direct de UI hertekenen
                    renderCard();
                } else { 
                    trackList = [...trackList, ...newTracks]; 
                }
                
                if(!document.getElementById('activeCard') && trackList.length > 0) renderCard();
            } catch (e) {
                console.error("Fout bij laden tracks:", e);
            } finally {
                isLoading = false;
            }
        }

        function renderCard() {
            const container = document.getElementById('tinderContainer');
            
            // Als we bijna door de lijst heen zijn, laad nieuwe
            if (currentIndex >= trackList.length - 3 && !isLoading) {
                loadTracks();
            }

            const t = trackList[currentIndex]; 
            
            if(!t) {
                container.innerHTML = '<div class="login-card"><h2>Even geduld...</h2><p>Nieuwe muziek wordt gezocht.</p></div>';
                return;
            }

            container.innerHTML = \`<div class="track-card" id="activeCard">
                <div class="stamp stamp-nope" id="nopeStamp">NOPE</div>
                <div class="stamp stamp-like" id="likeStamp">LIKE</div>
                <iframe src="https://open.spotify.com/embed/track/\${t.id}" width="100%" height="352" frameborder="0" allow="encrypted-media"></iframe>
                <div class="swipe-zone"></div>
            </div>\`;
            setupHammer();
        }

      let totalNopes = 0; 
        let totalLikes = 0; // Nieuwe teller voor het totaal aantal likes

        async function handleSwipe(action) {
            if (isAnimating) return; 
            
            const t = trackList[currentIndex];
            if (!t) return;

            isAnimating = true;

            let chosenMessage = "";

            if(action === 'like') { 
                sLikes++; 
                totalLikes++;
                sNopes = 0; // Reset nopes op een rij

                // --- LIKE FEEDBACK LOGICA ---
                const msgsLikeLow = [
                    "Feestje begint vorm te krijgen! 🎉",
                    "Goede smaak! Deze gaat op de lijst ✅",
                    "DJ-modus: AAN 🔥",
                    "De playlist wordt beter door jou!",
                    "Yes! Perfecte toevoeging! ✨"
                ];

                const msgsLikeMid = [
                    `Je bent op vuur vandaag! ${sLikes} hits! 🚀`,
                    "Feestgaranties in de maak! 🎶",
                    "Dit wordt ÉPISCH door jouw keuzes!",
                    `Like-streak: ${sLikes}! De crowd gaat los! 💥`,
                    "Jouw playlist-vibe is perfect 👌"
                ];

                const msgsLikeHigh = [
                    `WOW ${totalLikes} likes?! Jij BENT het feest! 🏆`,
                    "Super-DJ status unlocked! 🌟",
                    "De tuinfeest-playlist is nu 100% beter!",
                    `Record-breaker! ${totalLikes} parels gevonden 💎`,
                    "Spotify is jaloers op jouw playlist-smaak! 😎"
                ];

                if (sLikes === 3) {
                    chosenMessage = msgsLikeLow[Math.floor(Math.random() * msgsLikeLow.length)];
                } else if (sLikes >= 7 && sLikes <= 10) {
                    chosenMessage = msgsLikeMid[Math.floor(Math.random() * msgsLikeMid.length)];
                } else if (totalLikes === 12) { // Bij exact 12 totaal
                    chosenMessage = msgsLikeHigh[Math.floor(Math.random() * msgsLikeHigh.length)];
                } else if (totalLikes > 12 && totalLikes % 10 === 0) { // Daarna om de 10 likes
                    chosenMessage = msgsLikeHigh[Math.floor(Math.random() * msgsLikeHigh.length)];
                }

            } else { 
                sNopes++; 
                totalNopes++;
                sLikes = 0; // Reset likes op een rij

                // --- NOPE FEEDBACK LOGICA ---
                const msgsNopeLow = [
                    "Tough crowd vandaag! 😅 Laten we nieuwe vibes proberen.",
                    "Selectief gehoor? Slim! 🎯",
                    "Kwaliteitscontrole op volle toeren!",
                    "Jij bent de DJ-bouncer vanavond 🚪",
                    "Nope-festival geopend! 🎉"
                ];

                const msgsNopeMid = [
                    "Zullen we even andere hoeken van de playlist induiken? 🔄",
                    "Jouw 'nee' is sterker dan mijn playlist-algoritme 💪",
                    "Feestpubliek moet nog even bijkomen van jouw standaarden...",
                    `Nope-counter: ${totalNopes}. Personal record? 🏆`,
                    "Dit is waarom jij de selector bent 👑"
                ];

                const msgsNopeHigh = [
                    "WOW. Jij bent de koning(in) van 'nee zeggen'! 😎",
                    "Zelfs Spotify zweet nu... laten we refreshen! 😉",
                    "Jouw veto-power breekt records 🚀",
                    "De playlist huilt, maar ik bewonder je principes! 😂"
                ];

                if (sNopes === 3) {
                    chosenMessage = msgsNopeLow[Math.floor(Math.random() * msgsNopeLow.length)];
                } else if (sNopes >= 7 && sNopes <= 10) {
                    chosenMessage = msgsNopeMid[Math.floor(Math.random() * msgsNopeMid.length)];
                } else if (totalNopes >= 12 && totalNopes % 5 === 0) { // Om de 5 nopes bij hoge irritatie
                    chosenMessage = msgsNopeHigh[Math.floor(Math.random() * msgsNopeHigh.length)];
                }

                // Forceer refresh bij 5 nopes
                if(sNopes === 5) { 
                    if (chosenMessage) showToast(chosenMessage);
                    sNopes = 0; 
                    const el = document.getElementById('activeCard');
                    if(el) el.style.opacity = '0';
                    isAnimating = false;
                    loadTracks(true); 
                    return; 
                } 
            }

            // Toon de gekozen toast (als die er is)
            if (chosenMessage) showToast(chosenMessage);

            // --- DE STANDAARD ANIMATIE EN API CALL ---
            const el = document.getElementById('activeCard');
            const moveX = action === 'like' ? 1000 : -1000;
            
            if(el) {
                el.style.transition = 'transform 0.5s ease-in, opacity 0.5s';
                el.style.transform = 'translate(' + moveX + 'px, 0px) rotate(' + (moveX/10) + 'deg)';
                el.style.opacity = '0';
            }

            fetch('/api/interact', { 
                method: 'POST', 
                headers: {'Content-Type': 'application/json'}, 
                body: JSON.stringify({ 
                    track_id: t.id, action, uri: t.uri, track_name: t.name, artist_name: t.artists[0].name, artist_id: t.artists[0].id 
                })
            });

            setTimeout(() => { 
                currentIndex++; 
                isAnimating = false; 
                renderCard(); 
            }, 500);
        }

        function setupHammer() {
            const el = document.getElementById('activeCard'); 
            if(!el) return;
            const hammer = new Hammer(el.querySelector('.swipe-zone'));
            hammer.on('pan', (ev) => {
                if (isAnimating) return;
                el.style.transform = 'translate(' + ev.deltaX + 'px, ' + ev.deltaY + 'px) rotate(' + (ev.deltaX / 15) + 'deg)';
                const op = Math.min(Math.abs(ev.deltaX) / 150, 1);
                if (ev.deltaX > 0) { 
                    document.getElementById('likeStamp').style.opacity = op; 
                    document.getElementById('nopeStamp').style.opacity = 0; 
                } else { 
                    document.getElementById('nopeStamp').style.opacity = op; 
                    document.getElementById('likeStamp').style.opacity = 0; 
                }
            });
            hammer.on('panend', (ev) => {
                if (isAnimating) return;
                if (ev.deltaX > 150) handleSwipe('like'); 
                else if (ev.deltaX < -150) handleSwipe('nope');
                else { 
                    el.style.transform = ''; 
                    document.getElementById('likeStamp').style.opacity = 0; 
                    document.getElementById('nopeStamp').style.opacity = 0; 
                }
            });
        }
        loadTracks();` : ''}
    </script>
</body>
</html>`);
});

// --- DASHBOARD PAGINA ---

app.get('/dashboard', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.redirect('/');
    try {
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
        <div class="login-card" style="max-height: 85vh; overflow-y: auto;">
            <h2 class="login-header-main">Lekker bezig, ${user.username}!</h2>
            <div class="stats-row" style="display:flex; justify-content: space-around; margin: 20px 0; border-bottom: 1px solid #eee; padding-bottom: 15px;">
                <div style="text-align:center;"><strong style="font-size:1.5rem; color:#1DB954;">${stats.likes}</strong><br><small>Likes</small></div>
                <div style="text-align:center;"><strong style="font-size:1.5rem; color:#fe8777;">${stats.nopes}</strong><br><small>Nopes</small></div>
            </div>
            <div style="text-align:left; margin-bottom: 25px;">
                <h3 style="font-family:'Bebas Neue'; color:#fe8777; border-bottom: 2px solid #f0f0f0;">Top 5 Artiesten</h3>
                <ul style="list-style:none; padding:0; margin-top:10px;">
                    ${artistRes.rows.map(a => `<li style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f9f9f9;"><span>${a.artist_name}</span><span style="color:#888;">${a.count}x</span></li>`).join('') || '<li>Nog geen likes</li>'}
                </ul>
            </div>
            <div style="text-align:left;">
                <h3 style="font-family:'Bebas Neue'; color:#fe8777; border-bottom: 2px solid #f0f0f0;">Laatst Geliket</h3>
                <ul style="list-style:none; padding:0; margin-top:10px;">
                    ${trackRes.rows.map(t => `<li style="margin-bottom:12px; border-left: 3px solid #1DB954; padding-left:10px;"><strong>${t.track_name}</strong><br><small>${t.artist_name}</small></li>`).join('') || '<li>Nog geen nummers</li>'}
                </ul>
            </div>
            <button onclick="window.location.href='/'" class="btn-start" style="margin-top:20px; width:100%;">BACK TO SWIPE</button>
        </div>
    </main>
</body>
</html>`);
    } catch (e) { res.status(500).send("Fout bij laden dashboard"); }
});

app.listen(port, () => console.log(`Feest op poort ${port}`));
