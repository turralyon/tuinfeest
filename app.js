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

// --- API ROUTES ---

app.get('/api/tracks', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();

    try {
        const token = await refreshIfNeeded();
        // We halen nog steeds de geschiedenis op om te voorkomen dat je dubbele nummers ziet
        const historyRes = await db.query(
            "SELECT track_id, action, artist_name, username FROM history WHERE (username = $1 OR track_id = 'BAN_ARTIST')", 
            [user.username]
        );
        
        const history = historyRes.rows || [];
        const viewed = new Set(history.filter(h => h.username === user.username).map(h => h.track_id));
        const artistBans = new Set(history.filter(h => h.track_id === 'BAN_ARTIST').map(h => h.action.toLowerCase()));
        const favoriteArtists = history.filter(h => h.action === 'like' && h.username === user.username).map(h => h.artist_name);

        const playlistInfo = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}?fields=tracks.total`, { 
            headers: { Authorization: `Bearer ${token}` } 
        });
        
        const totalTracks = playlistInfo.data.tracks.total;
        const offset = Math.floor(Math.random() * Math.max(0, totalTracks - 50));
        
        const resp = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}/tracks?limit=50&offset=${offset}`, { 
            headers: { Authorization: `Bearer ${token}` } 
        });

        let candidates = resp.data.items
            .map(i => i.track)
            .filter(t => t && t.id && !viewed.has(t.id) && !artistBans.has(t.artists[0].name.toLowerCase()));

        candidates.sort((a, b) => {
            const aIsFav = favoriteArtists.includes(a.artists[0].name) ? 1 : 0;
            const bIsFav = favoriteArtists.includes(b.artists[0].name) ? 1 : 0;
            return bIsFav - aIsFav;
        });

        res.json(candidates.slice(0, 10));
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

app.post('/api/interact', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();
    const { track_id, action, uri, track_name, artist_name } = req.body;

    try {
        await db.query(
            'INSERT INTO history (username, track_id, action, track_name, artist_name) VALUES ($1, $2, $3, $4, $5)', 
            [user.username, track_id, action, track_name, artist_name]
        );

        if (action === 'like') {
            const token = await refreshIfNeeded();
            await axios.post(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_TARGET_PLAYLIST_ID}/tracks`, { uris: [uri] }, { 
                headers: { Authorization: `Bearer ${token}` } 
            });
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        // 1. Zoek de gebruiker op naam
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (!user) {
            return res.json({ ok: false });
        }

        let isMatch = false;
        const isAlreadyHashed = user.password.startsWith('$2b$');

        if (!isAlreadyHashed) {
            // 2. LAZY MIGRATION: Check plaintext
            if (password === user.password) {
                isMatch = true;
                // Wachtwoord klopt, dus nu direct hashen voor de volgende keer!
                const newHash = await bcrypt.hash(password, saltRounds);
                await db.query('UPDATE users SET password = $1 WHERE id = $2', [newHash, user.id]);
                console.log(`Wachtwoord voor ${username} is succesvol gemigreerd naar een hash.`);
            }
        } else {
            // 3. STANDAARD: Check hash via bcrypt
            isMatch = await bcrypt.compare(password, user.password);
        }

        // 4. Afhandeling van de login
        if (isMatch) {
            const token = uuidv4();
            await db.query('UPDATE users SET token = $1 WHERE id = $2', [token, user.id]);
            res.cookie('user_auth', token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
            res.json({ ok: true });
        } else {
            res.json({ ok: false });
        }

    } catch (e) { 
        console.error(e);
        res.status(500).send("Server fout"); 
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('user_auth');
    res.redirect('/');
});

// --- MAIN PAGE ---

app.get('/', async (req, res) => {
    const user = await getActiveUser(req);
    const showSwipe = !!user;
    res.send(`
    <!DOCTYPE html>
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
                <div class="tinder-container"><div class="track-card login-card">
                    <h2>Log In</h2>
                    <input type="text" id="userInput" placeholder="Naam">
                    <input type="password" id="passInput" placeholder="Wachtwoord">
                    <button onclick="login()" class="btn-start">START</button>
                    <p id="msg" style="color:#ff6b6b"></p>
                </div></div>
            ` : `
                <div class="status-bar">Lekker bezig, <b>${user.username}</b>!</div>
                <div class="tinder-container" id="tinderContainer"></div>
                <div class="controls">
                    <button class="circle-btn btn-nope" onclick="handleSwipe('nope')">✖</button>
                    <button class="circle-btn btn-like" onclick="handleSwipe('like')">❤</button>
                </div>
            `}
        </main>
        <script>
            async function login() {
                const username = document.getElementById('userInput').value;
                const password = document.getElementById('passInput').value;
                const r = await fetch('/api/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password }) });
                const d = await r.json();
                if (d.ok) location.reload(); else document.getElementById('msg').innerText = "Foutje!";
            }
            ${showSwipe ? `
                let trackList = []; let currentIndex = 0;
                async function loadTracks() {
                    const r = await fetch('/api/tracks');
                    const newTracks = await r.json();
                    trackList = [...trackList, ...newTracks];
                    if(currentIndex === 0) renderCard();
                }
                function renderCard() {
                    const container = document.getElementById('tinderContainer');
                    if (currentIndex >= trackList.length - 2) loadTracks();
                    const t = trackList[currentIndex];
                    if(!t) return;
                    container.innerHTML = '<div class="track-card" id="activeCard">' +
                        '<iframe src="https://open.spotify.com/embed/track/' + t.id + '" width="100%" height="352" frameborder="0" allow="encrypted-media"></iframe>' +
                        '<div class="swipe-zone" style="position:absolute; top:0; left:0; width:100%; height:260px; z-index:100"></div>' +
                        '</div>';
                    setupHammer();
                }
                function setupHammer() {
                    const el = document.getElementById('activeCard');
                    const hammer = new Hammer(el.querySelector('.swipe-zone'));
                    hammer.on('pan', (ev) => { el.style.transform = 'translate(' + ev.deltaX + 'px, ' + ev.deltaY + 'px) rotate(' + (ev.deltaX / 15) + 'deg)'; });
                    hammer.on('panend', (ev) => {
                        if (ev.deltaX > 140) handleSwipe('like');
                        else if (ev.deltaX < -140) handleSwipe('nope');
                        else el.style.transform = '';
                    });
                }
                async function handleSwipe(action) {
                    const t = trackList[currentIndex];
                    await fetch('/api/interact', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ track_id: t.id, action, uri: t.uri, track_name: t.name, artist_name: t.artists[0].name }) });
                    currentIndex++; renderCard();
                }
                loadTracks();
            ` : ''}
        </script>
    </body></html>`);
});

app.listen(port, () => console.log(`App draait op poort ${port}`));
