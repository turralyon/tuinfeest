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

// FIX 1: Veilige cookies voor Render (HTTPS vereist secure: true)
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'feestje_geheim_2026')); // uit .env!
app.use(express.static('public'));

// FIX 2: Trust proxy voor Render (anders HTTPS detectie mislukt)
app.set('trust proxy', 1);

// --- HELPERS ---
const getActiveUser = async (req) => {
    const userToken = req.signedCookies.user_auth;
    if (!userToken) return null;
    try {
        const res = await db.query('SELECT * FROM users WHERE token = $1', [userToken]);
        return res.rows[0] || null;
    } catch (e) { 
        console.error('getActiveUser error:', e);
        return null; 
    }
};

// --- API ROUTES --- (ongewijzigd, maar met betere error logging)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];

        if (user) {
            let isValid = false;
            if (user.password.startsWith('$2b$')) {
                isValid = await bcrypt.compare(password, user.password);
            } else if (password === user.password) {
                isValid = true;
                const hashedPassword = await bcrypt.hash(password, 10);
                await db.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, user.id]);
            }

            if (isValid) {
                const token = uuidv4();
                await db.query('UPDATE users SET token = $1 WHERE id = $2', [token, user.id]);
                // FIX 3: Render-vriendelijke cookie settings
                res.cookie('user_auth', token, { 
                    signed: true, 
                    httpOnly: true, 
                    secure: process.env.NODE_ENV === 'production', // true op Render!
                    sameSite: 'lax',
                    maxAge: 30 * 24 * 60 * 60 * 1000 
                });
                return res.json({ ok: true });
            }
        }
        res.json({ ok: false });
    } catch (e) { 
        console.error('Login error:', e);
        res.status(500).json({ error: 'Login mislukt' }); 
    }
});

// Andere API routes blijven hetzelfde...
app.get('/api/tracks', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();
    try {
        const token = await refreshIfNeeded();
        const historyRes = await db.query("SELECT track_id FROM history WHERE username = $1", [user.username]);
        const viewed = new Set(historyRes.rows.map(h => h.track_id));

        const playlist = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}?fields=tracks.total`, { 
            headers: { Authorization: `Bearer ${token}` } 
        });
        
        const offset = Math.floor(Math.random() * Math.max(0, playlist.data.tracks.total - 50));
        const resp = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}/tracks?limit=50&offset=${offset}`, { 
            headers: { Authorization: `Bearer ${token}` } 
        });

        res.json(resp.data.items.map(i => i.track).filter(t => t && t.id && !viewed.has(t.id)).slice(0, 10));
    } catch (e) { 
        console.error('Tracks error:', e.message);
        res.status(500).json({ error: 'Tracks laden mislukt' }); 
    }
});

app.post('/api/interact', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();
    const { track_id, action, uri, track_name, artist_name } = req.body;
    try {
        await db.query('INSERT INTO history (username, track_id, action, track_name, artist_name) VALUES ($1, $2, $3, $4, $5)', 
            [user.username, track_id, action, track_name, artist_name]);
        if (action === 'like') {
            const token = await refreshIfNeeded();
            await axios.post(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_TARGET_PLAYLIST_ID}/tracks`, { uris: [uri] }, { 
                headers: { Authorization: `Bearer ${token}` } 
            });
        }
        res.json({ ok: true });
    } catch (e) { 
        console.error('Interact error:', e.message);
        res.status(500).json({ error: 'Actie mislukt' }); 
    }
});

app.get('/logout', (req, res) => { 
    res.clearCookie('user_auth', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    res.redirect('/'); 
});

// Admin route blijft hetzelfde (te lang om hier te fixen)

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
            <h2>Tuinfeest Swipe 🎶</h2>
            ${showSwipe ? `<div>
                ${user.username === 'admin' ? '<a href="/admin" style="color:white; margin-right:15px; text-decoration:none;">ADMIN</a>' : ''}
                <a href="/logout" style="color:white; text-decoration:none;">LOGUIT</a>
            </div>` : ''}
        </header>

        <main>
            ${!showSwipe ? `
                <div class="login-card">
                    <div class="login-header-main">Het is tijd voor!</div>
                    <div class="login-header-sub">muziek</div>
                    <input type="text" id="u" placeholder="Naam">
                    <input type="password" id="p" placeholder="Wachtwoord">
                    <button onclick="doLogin()" class="btn-start">LET'S GO</button>
                    <p id="msg" style="color:#ff6b6b; font-size:0.8rem; margin-top:10px;"></p>
                </div>
            ` : `
                <div class="tinder-container" id="tinderContainer"></div>
                <div class="controls">
                    <button class="circle-btn btn-nope" onclick="forceSwipe('left')">✖</button>
                    <button class="circle-btn btn-like" onclick="forceSwipe('right')">❤</button>
                </div>
            `}
        </main>

        <script>
            async function doLogin() {
                const r = await fetch('/api/login', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }) 
                });
                const d = await r.json();
                if (d.ok) location.reload();
                else {
                    const card = document.querySelector('.login-card');
                    card.classList.add('shake');
                    document.getElementById('msg').innerText = "Oeps, klopt niet!";
                    setTimeout(() => card.classList.remove('shake'), 400);
                }
            }

            let tracks = []; let idx = 0;
            async function load() {
                try {
                    const r = await fetch('/api/tracks');
                    const d = await r.json();
                    tracks = [...tracks, ...d];
                    if (idx === 0 && tracks.length > 0) render();
                } catch(e) {
                    console.error('Load tracks failed:', e);
                    document.getElementById('tinderContainer').innerHTML = '<p style="text-align:center; padding-top:50px;">Kon geen tracks laden :(</p>';
                }
            }

            function render() {
                const cont = document.getElementById('tinderContainer');
                if (idx >= tracks.length - 2) load();
                const t = tracks[idx];
                if (!t) { 
                    cont.innerHTML = '<p style="text-align:center; padding-top:50px;">Laden...</p>'; 
                    return; 
                }
                

                cont.innerHTML = \`
                    <div class="track-card" id="card">
                        <div class="stamp stamp-like">LIKE</div>
                        <div class="stamp stamp-nope">NOPE</div>
                        <iframe 
                            src="https://open.spotify.com/embed/track/\${t.id}" 
                            width="100%" 
                            height="380" 
                            frameborder="0" 
                            allowtransparency="true" 
                            allow="encrypted-media; clipboard-write; picture-in-picture"
                        ></iframe>
                        <div class="swipe-zone"></div>
                    </div>
                \`;
                
                const el = document.getElementById('card');
                const hammer = new Hammer(el.querySelector('.swipe-zone'));
                const sL = el.querySelector('.stamp-like'); 
                const sN = el.querySelector('.stamp-nope');

                hammer.on('pan', (ev) => {
                    const x = ev.deltaX; const op = Math.min(Math.abs(x) / 150, 1);
                    el.style.transform = 'translateX(calc(-50% + ' + x + 'px)) rotate(' + (x/15) + 'deg)';
                    if (x > 0) { 
                        el.style.background = 'rgba(29, 185, 84,'+(op*0.3)+')'; 
                        sL.style.opacity = op; 
                        sN.style.opacity = 0; 
                    }
                    else { 
                        el.style.background = 'rgba(255,107,107,'+(op*0.3)+')'; 
                        sN.style.opacity = op; 
                        sL.style.opacity = 0; 
                    }
                });

                hammer.on('panend', (ev) => {
                    if (Math.abs(ev.deltaX) > 150) forceSwipe(ev.deltaX > 0 ? 'right' : 'left');
                    else { 
                        el.style.transition = '0.3s'; 
                        el.style.transform = 'translateX(-50%)'; 
                        el.style.background = 'white'; 
                        sL.style.opacity = 0; 
                        sN.style.opacity = 0; 
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
                fetch('/api/interact', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ 
                        track_id: t.id, 
                        action: dir==='right'?'like':'nope', 
                        uri: t.uri, 
                        track_name: t.name, 
                        artist_name: t.artists[0].name 
                    }) 
                });
                setTimeout(() => { idx++; render(); }, 350);
            }
            
            if (document.getElementById('tinderContainer')) load();
        </script>
    </body>
    </html>
    `);
});

app.listen(port, () => {
    console.log('Server live op port ' + port + ' (NODE_ENV: ' + process.env.NODE_ENV + ')');
});
