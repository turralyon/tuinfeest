require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const bcrypt = require('bcrypt');
const { pool: db, initDb } = require('./db');
const { refreshIfNeeded } = require('./spotifyService');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 3000;
const saltRounds = 10;

app.use(express.json());
app.use(cookieParser('feestje_geheim_123'));
app.use(express.static('public'));

// Initialize database before starting server
initDb();

// --- HELPERS ---

const getActiveUser = async (req) => {
    const userToken = req.signedCookies.user_auth;
    if (!userToken) return null;
    try {
        const res = await db.query('SELECT * FROM users WHERE token = $1', [userToken]);
        return res.rows[0] || null;
    } catch (e) { return null; }
};

async function getArtistGenres(artistId, token, artistName = '') {
    // Try Spotify artist genres first
    try {
        const res = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.data && Array.isArray(res.data.genres) && res.data.genres.length > 0) return res.data.genres;
    } catch (e) {
        // continue to fallbacks
    }

    // Fallback 1: iTunes Search API (no API key required) using artist name
    if (artistName && artistName.length > 0) {
        try {
            const itunes = await axios.get('https://itunes.apple.com/search', {
                params: { term: artistName, entity: 'musicArtist', limit: 1 }
            });
            const results = itunes.data && itunes.data.results;
            if (Array.isArray(results) && results.length > 0 && results[0].primaryGenreName) {
                return [results[0].primaryGenreName];
            }
        } catch (e) {
            // ignore and continue
        }
    }

    // Fallback 2: MusicBrainz tags (no API key) - return top tag names
    if (artistName && artistName.length > 0) {
        try {
            const mb = await axios.get('https://musicbrainz.org/ws/2/artist/', {
                params: { query: `artist:${artistName}`, fmt: 'json', limit: 1 },
                headers: { 'User-Agent': 'tuinfeest/1.0 (example@example.com)' }
            });
            const artists = mb.data && mb.data.artists;
            if (Array.isArray(artists) && artists.length > 0) {
                const artist = artists[0];
                if (artist.tags && Array.isArray(artist.tags) && artist.tags.length > 0) {
                    // return top 3 tags
                    return artist.tags.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 3).map(t => t.name);
                }
            }
        } catch (e) {
            // ignore
        }
    }

    return [];
}

async function getPlaylistDurationMs(token) {
    try {
        const playlistId = process.env.SPOTIFY_TARGET_PLAYLIST_ID;
        let total = 0;
        let offset = 0;
        const limit = 100;
        while (true) {
            const res = await axios.get(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
                headers: { Authorization: `Bearer ${token}` },
                params: { fields: 'items(track(duration_ms)),next', limit, offset }
            });
            const items = res.data.items || [];
            items.forEach(it => { if (it.track && it.track.duration_ms) total += it.track.duration_ms; });
            if (!res.data.next || items.length < limit) break;
            offset += limit;
        }
        return total;
    } catch (e) {
        return 0;
    }
}

// --- API ROUTES ---

app.get('/api/tracks', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user) return res.status(401).send();

    try {
        const token = await refreshIfNeeded();
        const historyRes = await db.query("SELECT track_id, action, genres FROM history WHERE (username = $1 OR track_id = 'BAN_ARTIST')", [user.username]);
        const history = historyRes.rows || [];
        const viewed = new Set(history.filter(h => h.username === user.username).map(h => h.track_id));
        const artistBans = new Set(history.filter(h => h.track_id === 'BAN_ARTIST').map(h => h.action.toLowerCase()));
        
        // Get tracks already in target playlist
        const targetPlaylist = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_TARGET_PLAYLIST_ID}/tracks?fields=items(track(id))`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const inPlaylist = new Set(targetPlaylist.data.items.map(i => i.track?.id));
        
        const playlistInfo = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}?fields=tracks.total`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const totalTracks = playlistInfo.data.tracks.total;
        let offset = Math.floor(Math.random() * Math.max(0, totalTracks - 50));

        const resp = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_SOURCE_PLAYLIST_ID}/tracks?limit=50&offset=${offset}`, {
            headers: { Authorization: `Bearer ${token}` }
        });

        let candidates = resp.data.items.map(i => i.track).filter(t => t && t.id && !viewed.has(t.id) && !inPlaylist.has(t.id) && !artistBans.has(t.artists[0].name.toLowerCase()));

        // Build user-specific genre scores (normalize keys)
        const genreScores = {};
        history.filter(h => h.action === 'like' && h.username === user.username).forEach(h => {
            if (h.genres) h.genres.split(',').forEach(g => {
                const key = g.toLowerCase().trim();
                if (!key) return;
                genreScores[key] = (genreScores[key] || 0) + 1;
            });
        });

        // Build global genre popularity map (aggregate across users)
        const globalMap = {};
        try {
            const topGenresResAll = await db.query("SELECT genres, COUNT(*) as count FROM history WHERE action = 'like' AND genres != '' GROUP BY genres");
            topGenresResAll.rows.forEach(row => {
                const cnt = parseInt(row.count, 10) || 0;
                if (!row.genres) return;
                row.genres.split(',').forEach(g => {
                    const key = g.toLowerCase().trim();
                    if (!key) return;
                    globalMap[key] = (globalMap[key] || 0) + cnt;
                });
            });
        } catch (e) {
            // ignore global map errors, continue with empty globalMap
        }

        // Fetch temp genres for candidate tracks (limit calls)
        for (let track of candidates.slice(0, 15)) {
            const tg = await getArtistGenres(track.artists[0].id, token, track.artists[0].name);
            track.temp_genres = (tg || []).map(x => (x || '').toLowerCase().trim()).filter(Boolean);
        }

        // Scoring mix: 80% user preference, 20% global popularity
        const USER_WEIGHT = 0.8;
        const GLOBAL_WEIGHT = 0.2;

        const scoreForTrack = (track) => {
            const genres = track.temp_genres || [];
            return genres.reduce((acc, g) => {
                const u = genreScores[g] || 0;
                const gg = globalMap[g] || 0;
                return acc + (USER_WEIGHT * u) + (GLOBAL_WEIGHT * gg);
            }, 0);
        };

        // Compute scores
        candidates.forEach(c => c._score = scoreForTrack(c));

        // Determine final selection: 80% top personalized, 20% exploration random
        const finalCount = Math.min(10, candidates.length);
        const personalizedCount = Math.ceil(finalCount * 0.8);
        const explorationCount = finalCount - personalizedCount;

        // Sort by score desc
        const sorted = candidates.slice().sort((a, b) => (b._score || 0) - (a._score || 0));
        const selected = [];
        const pickedIds = new Set();

        // pick top personalized
        for (let i = 0; i < sorted.length && selected.length < personalizedCount; i++) {
            selected.push(sorted[i]);
            pickedIds.add(sorted[i].id);
        }

        // exploration pool: those not picked yet
        const pool = candidates.filter(c => !pickedIds.has(c.id));
        // shuffle pool
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        for (let i = 0; i < explorationCount && i < pool.length; i++) selected.push(pool[i]);

        res.json(selected.slice(0, finalCount));
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
            // Check if track already exists in target playlist (ids)
            const targetPlaylist = await axios.get(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_TARGET_PLAYLIST_ID}/tracks?fields=items(track(id)),total`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const existingIds = new Set(targetPlaylist.data.items.map(i => i.track?.id));

            // Only add if not already in playlist
            if (!existingIds.has(track_id)) {
                const genres = await getArtistGenres(artist_id, token, artist_name);
                genresStr = genres.join(',');

                // Check playlist duration limit (8 hours)
                const currentMs = await getPlaylistDurationMs(token);
                // fetch the candidate track duration
                let trackDurMs = 0;
                try {
                    const tr = await axios.get(`https://api.spotify.com/v1/tracks/${track_id}`, { headers: { Authorization: `Bearer ${token}` } });
                    trackDurMs = tr.data && tr.data.duration_ms ? tr.data.duration_ms : 0;
                } catch (e) { trackDurMs = 0; }

                const MAX_MS = 8 * 60 * 60 * 1000; // 8 hours
                if ((currentMs + trackDurMs) <= MAX_MS) {
                    await axios.post(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_TARGET_PLAYLIST_ID}/tracks`, { uris: [uri] }, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    // mark that it was added
                    req._addedToPlaylist = true;
                } else {
                    // Do not add to playlist when it would exceed 8 hours
                    req._addedToPlaylist = false;
                    console.log('Playlist max duration reached - skipping add');
                }
            }
        }
        await db.query('INSERT INTO history (username, track_id, action, track_name, artist_name, genres) VALUES ($1, $2, $3, $4, $5, $6)', 
            [user.username, track_id, action, track_name, artist_name, genresStr]);
        const added = (typeof req._addedToPlaylist === 'boolean') ? req._addedToPlaylist : true;
        const reason = added ? null : 'max_duration';
        res.json({ ok: true, added, reason });
    } catch (e) { res.status(500).send(e.message); }
});

// provide current playlist progress (ms, max, pct, display)
app.get('/api/playlist-progress', async (req, res) => {
    try {
        const token = await refreshIfNeeded();
        if (!token) return res.json({ ms: 0, maxMs: 8 * 60 * 60 * 1000, pct: 0, display: '0h 0m / 8h 0m' });
        const ms = await getPlaylistDurationMs(token);
        const maxMs = 8 * 60 * 60 * 1000;
        const pct = Math.min(100, Math.round((ms / maxMs) * 100));
        const fmt = (ms) => {
            const s = Math.floor(ms / 1000);
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            return `${h}h ${m}m`;
        };
        return res.json({ ms, maxMs, pct, display: `${fmt(ms)} / ${fmt(maxMs)}` });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// --- AUTH ---

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.json({ ok: false });
        const isMatch = await bcrypt.compare(password, user.password);
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

app.post('/api/register', async (req, res) => {
    const { username, password, code } = req.body;
    
    // Validatie uitnodigingscode
    if (!code) {
        return res.json({ ok: false, msg: "Uitnodigingscode vereist" });
    }
    
    // Check of de uitnodigingscode bestaat en nog niet gebruikt is
    try {
        const inviteRes = await db.query('SELECT * FROM invitations WHERE code = $1 AND used = FALSE', [code]);
        if (inviteRes.rows.length === 0) {
            return res.json({ ok: false, msg: "Ongeldige of verlopen uitnodigingscode" });
        }
        
        const invite = inviteRes.rows[0];
        
        // Controleer dat de username overeenkomt met de uitnodiging
        if (username !== invite.username) {
            return res.json({ ok: false, msg: "Gebruikersnaam komt niet overeen met uitnodiging" });
        }
        
        // Check of gebruiker al bestaat
        const existing = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        if (existing.rows.length > 0) {
            return res.json({ ok: false, msg: "Gebruiker bestaat al" });
        }
        
        // Validatie wachtwoord
        if (!password || password.length < 6) {
            return res.json({ ok: false, msg: "Wachtwoord moet minimaal 6 tekens zijn" });
        }
        
        // Nieuwe gebruiker aanmaken
        const hashedPass = await bcrypt.hash(password, saltRounds);
        const token = uuidv4();
        await db.query('INSERT INTO users (username, password, token) VALUES ($1, $2, $3)', [username, hashedPass, token]);
        
        // Markeer uitnodiging als gebruikt
        await db.query('UPDATE invitations SET used = TRUE WHERE code = $1', [code]);
        
        // Direct inloggen
        res.cookie('user_auth', token, { signed: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
        res.json({ ok: true });
    } catch (e) {
        console.error('Register error:', e);
        res.status(500).json({ ok: false, msg: "Server fout" });
    }
});

// --- ADMIN: Uitnodigingen beheren ---

app.post('/api/admin/create-invite', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user || user.username !== 'admin') {
        return res.status(403).json({ ok: false, msg: "Alleen admin kan uitnodigingen aanmaken" });
    }
    
    const { username } = req.body;
    
    if (!username || username.length < 3) {
        return res.json({ ok: false, msg: "Gebruikersnaam moet minimaal 3 tekens zijn" });
    }
    
    try {
        // Check of gebruiker al bestaat
        const existingUser = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        if (existingUser.rows.length > 0) {
            return res.json({ ok: false, msg: "Gebruiker bestaat al" });
        }
        
        // Check of er al een uitnodiging is voor deze gebruiker
        const existingInvite = await db.query('SELECT * FROM invitations WHERE username = $1', [username]);
        if (existingInvite.rows.length > 0) {
            const code = existingInvite.rows[0].code;
            const used = existingInvite.rows[0].used;
            return res.json({ ok: true, code, used, msg: "Uitnodiging bestaat al" });
        }
        
        // Genereer unieke code
        const code = 'TUIN' + Math.random().toString(36).substring(2, 8).toUpperCase();
        
        await db.query('INSERT INTO invitations (code, username) VALUES ($1, $2)', [code, username]);
        
        res.json({ ok: true, code, used: false });
    } catch (e) {
        console.error('Create invite error:', e);
        res.status(500).json({ ok: false, msg: "Server fout" });
    }
});

app.get('/api/admin/invites', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user || user.username !== 'admin') {
        return res.status(403).json({ ok: false, msg: "Alleen admin kan uitnodigingen bekijken" });
    }
    
    try {
        const result = await db.query('SELECT * FROM invitations ORDER BY created_at DESC');
        res.json({ ok: true, invites: result.rows });
    } catch (e) {
        res.status(500).json({ ok: false, msg: "Server fout" });
    }
});

app.get('/admin/invites', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user || user.username !== 'admin') {
        return res.status(403).send('Forbidden');
    }
    
    const baseUrl = process.env.ACTIVATION_URL || `http://localhost:${port}`;
    
    res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Uitnodigingen Beheren</title>
    <link rel="stylesheet" href="/style.css">
    <style>
        .admin-container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .invite-form { display: flex; gap: 10px; margin-bottom: 20px; }
        .invite-form input { flex: 1; padding: 12px; border-radius: 8px; border: 2px solid #1DB954; font-size: 1rem; }
        .invite-form button { padding: 12px 24px; background: #1DB954; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold; }
        .invite-list { list-style: none; padding: 0; }
        .invite-item { background: white; padding: 15px; margin-bottom: 10px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
        .invite-item.used { opacity: 0.6; background: #f5f5f5; }
        .invite-header { display: flex; justify-content: space-between; align-items: center; }
        .invite-link { background: #f0f0f0; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 0.85rem; word-break: break-all; }
        .copy-btn { background: #fe8777; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 0.75rem; margin-left: 8px; }
        .status-badge { padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; }
        .status-used { background: #ddd; color: #666; }
        .status-active { background: #1DB954; color: white; }
        .back-link { display: inline-block; margin-bottom: 20px; color: #1DB954; text-decoration: none; }
    </style>
</head>
<body>
    <header>
        <div class="user-menu"><a href="/" class="nav-link">SWIPE</a></div>
        <h1>📩 Uitnodigingen Beheren</h1>
        <div class="user-menu"><a href="/logout" class="logout-link">LOGUIT</a></div>
    </header>
    <main>
        <div class="admin-container">
            <a href="/" class="back-link">← Terug naar Swipe</a>
            
            <div class="login-card">
                <h3>Nieuwe uitnodiging aanmaken</h3>
                <div class="invite-form">
                    <input type="text" id="usernameInput" placeholder="Gebruikersnaam voor gast">
                    <button onclick="createInvite()">Aanmaken</button>
                </div>
                <div id="newInviteResult" style="margin-top: 15px; display: none;">
                    <p style="color: #1DB954; font-weight: bold;">✅ Uitnodiging aangemaakt!</p>
                    <p>Deel deze link met de gast:</p>
                    <div class="invite-link" id="newInviteLink"></div>
                    <button class="copy-btn" onclick="copyNewLink()">Kopiëren</button>
                </div>
            </div>
            
            <h3 style="margin-top: 30px; color: #1DB954;">Alle uitnodigingen</h3>
            <ul class="invite-list" id="inviteList">
                <li style="text-align: center; padding: 20px; color: #888;">Laden...</li>
            </ul>
        </div>
    </main>
    
    <script>
        const baseUrl = '${baseUrl}';
        let latestLink = '';
        
        async function createInvite() {
            const username = document.getElementById('usernameInput').value.trim();
            if (!username) {
                alert('Voer een gebruikersnaam in');
                return;
            }
            
            try {
                const r = await fetch('/api/admin/create-invite', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ username })
                });
                const d = await r.json();
                
                if (d.ok) {
                    const link = baseUrl + '/?user=' + encodeURIComponent(username) + '&code=' + encodeURIComponent(d.code);
                    latestLink = link;
                    document.getElementById('newInviteResult').style.display = 'block';
                    document.getElementById('newInviteLink').textContent = link;
                    document.getElementById('usernameInput').value = '';
                    loadInvites();
                } else {
                    alert(d.msg || 'Fout bij aanmaken');
                }
            } catch (e) {
                alert('Fout: ' + e.message);
            }
        }
        
        function copyNewLink() {
            navigator.clipboard.writeText(latestLink).then(() => {
                alert('Link gekopieerd!');
            });
        }
        
        async function loadInvites() {
            try {
                const r = await fetch('/api/admin/invites', { credentials: 'same-origin' });
                const d = await r.json();
                
                if (d.ok && d.invites) {
                    const list = document.getElementById('inviteList');
                    if (d.invites.length === 0) {
                        list.innerHTML = '<li style="text-align: center; padding: 20px; color: #888;">Nog geen uitnodigingen</li>';
                        return;
                    }
                    
                    list.innerHTML = d.invites.map(inv => {
                        const link = baseUrl + '/?user=' + encodeURIComponent(inv.username) + '&code=' + encodeURIComponent(inv.code);
                        return \`<li class="invite-item \${inv.used ? 'used' : ''}">
                            <div class="invite-header">
                                <strong>\${inv.username}</strong>
                                <span class="status-badge \${inv.used ? 'status-used' : 'status-active'}">\${inv.used ? 'GEBRUIKT' : 'ACTIEF'}</span>
                            </div>
                            <div style="margin-top: 10px;">
                                <span class="invite-link">\${link}</span>
                                <button class="copy-btn" onclick="navigator.clipboard.writeText('\${link.replace(/'/g, "\\'")}').then(() => alert('Gekopieerd!'))">Kopiëren</button>
                            </div>
                            <small style="color: #888; display: block; margin-top: 8px;">Aangemaakt: \${new Date(inv.created_at).toLocaleDateString('nl-NL')}</small>
                        </li>\`;
                    }).join('');
                }
            } catch (e) {
                console.error('Error loading invites:', e);
            }
        }
        
        loadInvites();
    </script>
</body>
</html>`);
});

app.get('/logout', (req, res) => { res.clearCookie('user_auth'); res.redirect('/'); });

// --- LEADERBOARD ---

app.get('/api/search-users', async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 1) return res.json({ users: [] });
    
    try {
        const result = await db.query('SELECT username FROM users WHERE username ILIKE $1 LIMIT 10', ['%' + query + '%']);
        const users = [];
        
        for (const user of result.rows) {
            const countRes = await db.query("SELECT action, COUNT(*) as count FROM history WHERE username = $1 GROUP BY action", [user.username]);
            let stats = { likes: 0, nopes: 0 };
            countRes.rows.forEach(r => { if (r.action === 'like') stats.likes = r.count; if (r.action === 'nope') stats.nopes = r.count; });
            users.push({ username: user.username, stats });
        }
        
        res.json({ users });
    } catch (e) { res.status(500).json({ users: [] }); }
});

// --- LEADERBOARD ---

app.get('/leaderboard', async (req, res) => {
    const user = await getActiveUser(req);
    const isLoggedIn = !!user;
    
    try {
        // Include users with zero votes by left-joining against the users table
        const topLikersRes = await db.query(
            "SELECT u.username, COALESCE(l.count, 0) as count FROM users u LEFT JOIN (SELECT username, COUNT(*) as count FROM history WHERE action = 'like' GROUP BY username) l ON u.username = l.username ORDER BY count DESC LIMIT 10"
        );

        const topNopersRes = await db.query(
            "SELECT u.username, COALESCE(n.count, 0) as count FROM users u LEFT JOIN (SELECT username, COUNT(*) as count FROM history WHERE action = 'nope' GROUP BY username) n ON u.username = n.username ORDER BY count DESC LIMIT 10"
        );
        
        const topArtistsRes = await db.query(
            "SELECT artist_name, COUNT(*) as count FROM history WHERE action = 'like' GROUP BY artist_name ORDER BY count DESC LIMIT 10"
        );
        
        const topGenresRes = await db.query(
            "SELECT genres, COUNT(*) as count FROM history WHERE action = 'like' AND genres != '' GROUP BY genres ORDER BY count DESC LIMIT 50"
        );
        
        let topGenres = [];
        const genreMap = {};
        topGenresRes.rows.forEach(row => {
            if (row.genres) {
                const cnt = parseInt(row.count, 10) || 0;
                row.genres.split(',').forEach(g => {
                    const genre = g.trim();
                    if (genre) genreMap[genre] = (genreMap[genre] || 0) + cnt;
                });
            }
        });
        topGenres = Object.entries(genreMap).sort((a, b) => b[1] - a[1]).slice(0, 10);

        const topLikersHtml = topLikersRes.rows.map(r => '<li style="padding:10px 0; cursor:pointer; border-bottom:1px solid #eee;" onclick="window.location.href=' + "'/profile/" + r.username + "'" + '"><strong style="color:#1DB954;">' + r.username + '</strong><br><small>' + r.count + ' likes</small></li>').join('');
        const topNopersHtml = topNopersRes.rows.map(r => '<li style="padding:10px 0; cursor:pointer; border-bottom:1px solid #eee;" onclick="window.location.href=' + "'/profile/" + r.username + "'" + '"><strong style="color:#fe8777;">' + r.username + '</strong><br><small>' + r.count + ' nopes</small></li>').join('');
        const topArtistsHtml = topArtistsRes.rows.map(r => '<li style="padding:10px 0; border-bottom:1px solid #eee;"><strong>' + r.artist_name + '</strong><br><small>' + r.count + 'x geliked</small></li>').join('');
        const topGenresHtml = topGenres.map(g => '<li style="padding:10px 0; border-bottom:1px solid #eee;"><strong>' + g[0] + '</strong><br><small>' + g[1] + 'x</small></li>').join('');

        res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Leaderboard</title>
    <link rel="stylesheet" href="/style.css">
    <style>
        .tabs { display: flex; gap: 5px; margin-bottom: 15px; flex-wrap: wrap; }
        .tab-btn { flex: 1; min-width: 45%; padding: 8px; background: #eee; border: none; cursor: pointer; border-radius: 8px; font-weight: bold; }
        .tab-btn.active { background: #1DB954; color: white; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .search-box { width: 100%; padding: 10px; margin-bottom: 15px; border: 2px solid #1DB954; border-radius: 8px; font-size: 1rem; }
        @media (max-width: 600px) {
            .tab-btn { min-width: calc(50% - 3px); padding: 6px; font-size: 0.85rem; }
            ol { padding-left: 15px; margin: 0; }
            li { padding: 8px 0 !important; }
        }
    </style>
</head>
<body>
    <header>
        <div class="user-menu">${isLoggedIn ? '<a href="/" class="nav-link">SWIPE</a>' : ''}</div>
        <h1>🏆 Leaderboard</h1>
        <div class="user-menu">${isLoggedIn && user.username === 'admin' ? '<a href="/admin/invites" class="nav-link" style="margin-right:10px;">📩</a>' : ''}${isLoggedIn ? '<a href="/logout" class="logout-link">LOGUIT</a>' : '<a href="/" class="nav-link">LOGIN</a>'}</div>
    </header>
    <main>
        <div class="login-card" style="max-height: 90vh; overflow-y: auto;">
            <input type="text" class="search-box" id="searchInput" placeholder="🔍 Zoek gebruiker..." onkeyup="searchUsers()">
            
            <div class="tabs">
                <button class="tab-btn active" onclick="switchTab('likers')">👍 Likers</button>
                <button class="tab-btn" onclick="switchTab('nopers')">👎 Jury</button>
                <button class="tab-btn" onclick="switchTab('artists')">🎤 Artiesten</button>
                <button class="tab-btn" onclick="switchTab('genres')">🎵 Genres</button>
            </div>
            
            <div id="likers" class="tab-content active">
                <ol style="list-style: decimal; padding-left: 20px; margin: 0;">
                    ${topLikersHtml}
                </ol>
            </div>
            
            <div id="nopers" class="tab-content">
                <ol style="list-style: decimal; padding-left: 20px; margin: 0;">
                    ${topNopersHtml}
                </ol>
            </div>
            
            <div id="artists" class="tab-content">
                <ol style="list-style: decimal; padding-left: 20px; margin: 0;">
                    ${topArtistsHtml}
                </ol>
            </div>
            
            <div id="genres" class="tab-content">
                <ol style="list-style: decimal; padding-left: 20px; margin: 0;">
                    ${topGenresHtml}
                </ol>
            </div>
            
            <div id="searchResults" class="tab-content" style="display: none;">
                <ol id="resultsList" style="list-style: decimal; padding-left: 20px; margin: 0;"></ol>
            </div>
        </div>
    </main>
    
    <script>
        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.getElementById(tabName).classList.add('active');
            event.target.classList.add('active');
            document.getElementById('searchInput').value = '';
        }
        
        async function searchUsers() {
            const query = document.getElementById('searchInput').value.trim();
            const resultsDiv = document.getElementById('searchResults');
            const resultsList = document.getElementById('resultsList');
            
            if (query.length === 0) {
                resultsDiv.style.display = 'none';
                return;
            }
            
            try {
                const r = await fetch('/api/search-users?q=' + encodeURIComponent(query));
                const data = await r.json();
                
                if (data.users && data.users.length > 0) {
                    resultsList.innerHTML = data.users.map(u => 
                        '<li style="padding:10px 0; cursor:pointer; border-bottom:1px solid #eee;" onclick="window.location.href=' + "'/profile/" + u.username + "'" + '"><strong style="color:#1DB954;">' + u.username + '</strong><br><small>' + u.stats.likes + ' likes, ' + u.stats.nopes + ' nopes</small></li>'
                    ).join('');
                    resultsDiv.style.display = 'block';
                    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    resultsDiv.classList.add('active');
                } else {
                    resultsList.innerHTML = '<li style="padding:10px;">Geen gebruikers gevonden</li>';
                    resultsDiv.style.display = 'block';
                }
            } catch (e) {
                resultsList.innerHTML = '<li style="padding:10px; color:red;">Zoekfout</li>';
                resultsDiv.style.display = 'block';
            }
        }
    </script>
</body>
</html>`);
    } catch (e) { res.status(500).send("Fout bij laden leaderboard"); }
});

// --- ADMIN: trigger backfill (starts detached process) ---
app.get('/admin/backfill', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user || user.username !== 'admin') return res.status(403).send('Forbidden');

    res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Admin Backfill</title>
    <link rel="stylesheet" href="/style.css">
    <style>
        .admin-card { max-width: 420px; margin: 40px auto; padding: 20px; border-radius: 12px; background: white; color: #333; }
        .admin-card input { width: 100%; padding: 10px; margin-bottom: 10px; }
        .admin-card button { padding: 10px 15px; border-radius: 8px; }
        .status { margin-top: 10px; font-size: 0.95rem; }
    </style>
</head>
<body>
    <header>
        <div class="user-menu"><a href="/" class="nav-link">SWIPE</a></div>
        <h1>Admin Backfill</h1>
        <div class="user-menu"><a href="/logout" class="logout-link">LOGUIT</a></div>
    </header>
    <main>
        <div class="admin-card">
            <p>Start een éénmalige backfill om lege genres in te vullen.</p>
            <label>Max aantal rijen om bij te werken</label>
            <input id="limit" type="number" value="100" min="1" />
            <div style="display:flex; gap:10px;">
                <button id="startBtn" class="btn-start">Start Backfill</button>
                <button id="smallBtn" class="btn-start" style="background:#fe8777;">Test 20</button>
            </div>
            <div id="status" class="status"></div>
        </div>
    </main>
    <script>
        document.getElementById('startBtn').addEventListener('click', async () => {
            const limit = document.getElementById('limit').value || '100';
            document.getElementById('status').textContent = 'Start backfill...';
            try {
                const r = await fetch('/admin/backfill', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ limit })
                });
                const data = await r.json();
                if (data.ok) document.getElementById('status').textContent = 'Backfill gestart (pid: ' + data.pid + ')';
                else document.getElementById('status').textContent = 'Fout: ' + (data.msg || 'unknown');
            } catch (e) { document.getElementById('status').textContent = 'Fetch error: ' + e.message; }
        });

        document.getElementById('smallBtn').addEventListener('click', () => { document.getElementById('limit').value = '20'; document.getElementById('startBtn').click(); });
    </script>
</body>
</html>`);
});
app.post('/admin/backfill', async (req, res) => {
    const user = await getActiveUser(req);
    if (!user || user.username !== 'admin') return res.status(403).json({ ok: false, msg: 'Forbidden' });

    const limit = req.query.limit || (req.body && req.body.limit) || process.env.BACKFILL_LIMIT || '1000';
    try {
        // spawn a detached node process to run the backfill script
        const child = spawn(process.execPath, ['scripts/backfill-genres.js', String(limit)], {
            detached: true,
            stdio: 'ignore',
            env: Object.assign({}, process.env)
        });
        child.unref();
        return res.json({ ok: true, msg: 'Backfill gestart', pid: child.pid });
    } catch (e) {
        return res.status(500).json({ ok: false, msg: e.message });
    }
});

// --- USER PROFILE ---

app.get('/profile/:username', async (req, res) => {
    const user = await getActiveUser(req);
    const isLoggedIn = !!user;
    const profileUsername = req.params.username;
    
    try {
        const userRes = await db.query('SELECT id FROM users WHERE username = $1', [profileUsername]);
        if (userRes.rows.length === 0) return res.status(404).send("Gebruiker niet gevonden");
        
        const countRes = await db.query("SELECT action, COUNT(*) as count FROM history WHERE username = $1 GROUP BY action", [profileUsername]);
        let stats = { likes: 0, nopes: 0 };
        countRes.rows.forEach(r => { if (r.action === 'like') stats.likes = r.count; if (r.action === 'nope') stats.nopes = r.count; });
        
        const artistRes = await db.query("SELECT artist_name, COUNT(*) as count FROM history WHERE username = $1 AND action = 'like' GROUP BY artist_name ORDER BY count DESC LIMIT 5", [profileUsername]);
        
        const genreRes = await db.query("SELECT genres FROM history WHERE username = $1 AND action = 'like' AND genres != ''", [profileUsername]);
        let topGenres = {};
        genreRes.rows.forEach(row => {
            if (row.genres) {
                row.genres.split(',').forEach(g => {
                    const genre = g.trim();
                    if (genre) topGenres[genre] = (topGenres[genre] || 0) + 1;
                });
            }
        });
        topGenres = Object.entries(topGenres).sort((a, b) => b[1] - a[1]).slice(0, 3);

        const artistsHtml = artistRes.rows.length > 0 
            ? '<ul style="list-style:none; padding:0;">' + artistRes.rows.map(a => '<li style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f9f9f9;"><span>' + a.artist_name + '</span><span style="color:#888;">' + a.count + 'x</span></li>').join('') + '</ul>'
            : '<p>Nog geen favoriete artiesten</p>';
        
        const genresHtml = topGenres.length > 0
            ? '<ul style="list-style:none; padding:0;">' + topGenres.map(g => '<li style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f9f9f9;"><span>' + g[0] + '</span><span style="color:#888;">' + g[1] + 'x</span></li>').join('') + '</ul>'
            : '<p>Nog geen genres</p>';

        res.send(`<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Profiel - ${profileUsername}</title>
    <link rel="stylesheet" href="/style.css">
</head>
<body>
    <header>
        <div class="user-menu"><a href="/leaderboard" class="nav-link">← LEADERBOARD</a></div>
        <h1>🎶 ${profileUsername}</h1>
        <div class="user-menu">${isLoggedIn ? '<a href="/logout" class="logout-link">LOGUIT</a>' : ''}</div>
    </header>
    <main>
        <div class="login-card" style="max-height: 90vh; overflow-y: auto;">
            <div class="stats-row" style="display:flex; justify-content: space-around; margin: 20px 0; border-bottom: 1px solid #eee; padding-bottom: 15px;">
                <div style="text-align:center;">
                    <strong style="font-size:2rem; color:#1DB954;">${stats.likes}</strong><br>
                    <small>Likes</small>
                </div>
                <div style="text-align:center;">
                    <strong style="font-size:2rem; color:#fe8777;">${stats.nopes}</strong><br>
                    <small>Nopes</small>
                </div>
            </div>
            
            <h3 style="color:#1DB954;">🎤 Top Artiesten</h3>
            ${artistsHtml}
            
            <h3 style="color:#9B59B6; margin-top:25px;">🎵 Favoriete Genres</h3>
            ${genresHtml}
            
            <button onclick="window.location.href='/leaderboard'" class="btn-start" style="width:100%; margin-top:25px;">TERUG</button>
        </div>
    </main>
</body>
</html>`);
    } catch (e) { res.status(500).send("Fout bij laden profiel"); }
});

// --- MAIN PAGE ---

app.get('/', async (req, res) => {
    const user = await getActiveUser(req);
    const showSwipe = !!user;
    // compute playlist progress (ms) towards 8 hours
    let playlistMs = 0;
    try {
        const token = await refreshIfNeeded();
        if (token) playlistMs = await getPlaylistDurationMs(token);
    } catch (e) { playlistMs = 0; }
    const MAX_MS = 8 * 60 * 60 * 1000;
    const pct = Math.min(100, Math.round((playlistMs / MAX_MS) * 100));
    const fmt = (ms) => {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `${h}h ${m}m`;
    };
    const playlistDisplay = `${fmt(playlistMs)} / ${fmt(MAX_MS)}`;
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
        <div class="user-menu">${showSwipe ? '<a href="/leaderboard" class="nav-link">🏆</a>' : ''}</div>
        <h1>Tuinfeest Swipe 🎶</h1>
        <div class="user-menu">${showSwipe ? '<a href="/dashboard" class="nav-link">👤</a>' : ''}</div>
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
                <a href="#" onclick="toggleForm('register')" class="small-link" style="display:block; margin-top:15px; font-size:0.8rem; color:#666;">Nog geen account? Registreer</a>
                <a href="#" onclick="toggleReset(true)" class="small-link" style="display:block; margin-top:10px; font-size:0.8rem; color:#666;">Wachtwoord vergeten?</a>
            </div>
            <div id="registerForm" class="login-card" style="display:none;">
                <h2 class="login-header-main">Nieuw bij</h2>
                <h1 class="login-header-sub">Tuinfeest</h1>
                <input type="text" id="regUser" placeholder="Naam" readonly style="background:#e0e0e0;">
                <div class="password-wrapper">
                    <input type="password" id="regPass" placeholder="Wachtwoord">
                    <span class="toggle-password" onclick="togglePasswordVisibility('regPass')">👁️</span>
                </div>
                <button onclick="register()" class="btn-start">REGISTREER</button>
                <a href="#" onclick="toggleForm('login')" class="small-link" style="display:block; margin-top:15px; font-size:0.8rem; color:#666;">Al een account? Login</a>
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
                <a href="#" onclick="toggleForm('login')" class="small-link" style="display:block; margin-top:15px; font-size:0.8rem; color:#666;">Terug naar login</a>
            </div>
        ` : `
            <div style="max-width:420px; margin: 10px auto;">
                <div style="background:#eee; border-radius:12px; padding:8px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; font-size:0.9rem; color:#333; margin-bottom:6px;">
                        <div id="playlistDisplay">Playlist: ${playlistDisplay}</div>
                        <div id="playlistPct">${pct}%</div>
                    </div>
                    <div style="background:#ddd; height:12px; border-radius:8px; overflow:hidden;">
                        <div id="playlistBar" style="width:${pct}%; height:100%; background:linear-gradient(90deg,#1DB954,#fe8777);"></div>
                    </div>
                </div>
            </div>
            <div class="tinder-container" id="tinderContainer"></div>
            <div class="controls">
                <button class="circle-btn btn-nope" onclick="handleSwipe('nope')">✖</button>
                <button class="circle-btn btn-like" onclick="handleSwipe('like')">❤</button>
                <button onclick="window.location.href='/logout'" style="position:absolute; bottom:20px; right:20px; padding:8px 15px; background:#fe8777; border:none; border-radius:20px; color:white; cursor:pointer; font-size:0.8rem;">loguit</button>
            </div>
        `}
    </main>
    <script>
        // Check URL parameters bij laden voor registratie link
        const urlParams = new URLSearchParams(window.location.search);
        const urlUsername = urlParams.get('user');
        const urlCode = urlParams.get('code');
        
        if (urlUsername && urlCode) {
            document.getElementById('regUser').value = urlUsername;
            // Store code in hidden field
            let codeInput = document.getElementById('regCode');
            if (!codeInput) {
                codeInput = document.createElement('input');
                codeInput.type = 'hidden';
                codeInput.id = 'regCode';
                document.getElementById('registerForm').appendChild(codeInput);
            }
            codeInput.value = urlCode;
            toggleForm('register');
        }
        
        function togglePasswordVisibility(id) {
            const input = document.getElementById(id);
            input.type = input.type === "password" ? "text" : "password";
        }
        function toggleForm(formName) {
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('resetForm').style.display = 'none';
            if (formName === 'login') document.getElementById('loginForm').style.display = 'block';
            else if (formName === 'register') document.getElementById('registerForm').style.display = 'block';
            else if (formName === 'reset') document.getElementById('resetForm').style.display = 'block';
        }
        function toggleReset(show) {
            toggleForm(show ? 'reset' : 'login');
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
        async function register() {
            const username = document.getElementById('regUser').value.trim();
            const password = document.getElementById('regPass').value;
            const code = document.getElementById('regCode') ? document.getElementById('regCode').value : '';
            
            if (!username) {
                alert("Gebruikersnaam is vereist");
                return;
            }
            if (!password) {
                alert("Wachtwoord is vereist");
                return;
            }
            if (!code) {
                alert("Uitnodigingscode ontbreekt");
                return;
            }
            
            const r = await fetch('/api/register', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ username, password, code }) });
            const d = await r.json();
            if (d.ok) location.reload();
            else alert(d.msg || "Registratie mislukt");
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
        let totalNopes = 0;
        let totalLikes = 0;
        let isLoading = false;

        async function loadTracks(force = false) {
            if (isLoading) return;
            isLoading = true;
            try {
                const r = await fetch(force ? '/api/tracks?refresh=true' : '/api/tracks');
                const newTracks = await r.json();
                if (force) { trackList = newTracks; currentIndex = 0; renderCard(); } 
                else { trackList = [...trackList, ...newTracks]; }
                if(!document.getElementById('activeCard') && trackList.length > 0) renderCard();
            } catch (e) { console.error("Fout:", e); } finally { isLoading = false; }
        }

        function renderCard() {
            const container = document.getElementById('tinderContainer');
            if (currentIndex >= trackList.length - 3 && !isLoading) loadTracks();
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

        async function handleSwipe(action) {
            if (isAnimating) return; 
            const t = trackList[currentIndex];
            if (!t) return;
            isAnimating = true;
            let chosenMessage = "";

            if(action === 'like') { 
                sLikes++; totalLikes++; sNopes = 0;
                const msgsLow = ["Feestje begint vorm te krijgen! 🎉", "Goede smaak! Deze gaat op de lijst ✅", "DJ-modus: AAN 🔥", "De playlist wordt beter door jou!", "Yes! Perfecte toevoeging! ✨"];
                const msgsMid = [\`Je bent op vuur vandaag! \${sLikes} hits! 🚀\`, "Feestgaranties in de maak! 🎶", "Dit wordt ÉPISCH door jouw keuzes!", \`Like-streak: \${sLikes}! De crowd gaat los! 💥\`, "Jouw playlist-vibe is perfect 👌"];
                const msgsHigh = [\`WOW \${totalLikes} likes?! Jij BENT het feest! 🏆\`, "Super-DJ status unlocked! 🌟", "De tuinfeest-playlist is nu 100% beter!", \`Record-breaker! \${totalLikes} parels gevonden 💎\`, "Spotify is jaloers op jouw playlist-smaak! 😎"];

                if (sLikes === 3) chosenMessage = msgsLow[Math.floor(Math.random() * msgsLow.length)];
                else if (sLikes >= 7 && sLikes <= 10) chosenMessage = msgsMid[Math.floor(Math.random() * msgsMid.length)];
                else if (totalLikes === 12 || (totalLikes > 12 && totalLikes % 10 === 0)) chosenMessage = msgsHigh[Math.floor(Math.random() * msgsHigh.length)];
            } else { 
                sNopes++; totalNopes++; sLikes = 0;
                const msgsNLow = ["Tough crowd vandaag! 😅 Laten we nieuwe vibes proberen.", "Selectief gehoor? Slim! 🎯", "Kwaliteitscontrole op volle toeren!", "Jij bent de DJ-bouncer vanavond 🚪", "Nope-festival geopend! 🎉"];
                const msgsNMid = ["Zullen we even andere hoeken van de playlist induiken? 🔄", "Jouw 'nee' is sterker dan mijn playlist-algoritme 💪", "Feestpubliek moet nog even bijkomen van jouw standaarden...", \`Nope-counter: \${totalNopes}. Personal record? 🏆\`, "Dit is waarom jij de selector bent 👑"];
                const msgsNHigh = ["WOW. Jij bent de koning(in) van 'nee zeggen'! 😎", "Zelfs Spotify zweet nu... laten we refreshen! 😉", "Jouw veto-power breekt records 🚀", "De playlist huilt, maar ik bewonder je principes! 😂"];

                if (sNopes === 3) chosenMessage = msgsNLow[Math.floor(Math.random() * msgsNLow.length)];
                else if (sNopes >= 7 && sNopes <= 10) chosenMessage = msgsNMid[Math.floor(Math.random() * msgsNMid.length)];
                else if (totalNopes >= 12 && totalNopes % 5 === 0) chosenMessage = msgsNHigh[Math.floor(Math.random() * msgsNHigh.length)];

                if(sNopes === 5) {
                    if (chosenMessage) showToast(chosenMessage);
                    sNopes = 0; isAnimating = false; loadTracks(true); return;
                }
            }

            if (chosenMessage) showToast(chosenMessage);
            const el = document.getElementById('activeCard');
            const moveX = action === 'like' ? 1000 : -1000;
            if(el) {
                el.style.transition = 'transform 0.5s ease-in, opacity 0.5s';
                el.style.transform = 'translate(' + moveX + 'px, 0px) rotate(' + (moveX/10) + 'deg)';
                el.style.opacity = '0';
            }

            try {
                const resp = await fetch('/api/interact', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    credentials: 'same-origin',
                    body: JSON.stringify({ track_id: t.id, action, uri: t.uri, track_name: t.name, artist_name: t.artists[0].name, artist_id: t.artists[0].id })
                });
                const data = await resp.json().catch(() => ({}));
                if (action === 'like') {
                    if (data && data.added === false) {
                        // show toast that the track wasn't added due to playlist limit
                        showToast('Track niet toegevoegd: playlist limiet bereikt (8 uur)');
                    } else {
                        // successful add -> refresh playlist progress live
                        try {
                            const pr = await fetch('/api/playlist-progress');
                            const pd = await pr.json();
                            if (pd) {
                                const bar = document.getElementById('playlistBar');
                                const pctEl = document.getElementById('playlistPct');
                                const disp = document.getElementById('playlistDisplay');
                                if (bar) bar.style.width = (pd.pct || 0) + '%';
                                if (pctEl) pctEl.textContent = (pd.pct || 0) + '%';
                                if (disp) disp.textContent = 'Playlist: ' + (pd.display || '');
                            }
                        } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) {
                console.error('Interact error', e);
            }

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

// --- DASHBOARD ---

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
                <h3 style="font-family:'Bebas Neue'; color:#fe8777;">Top 5 Artiesten</h3>
                <ul style="list-style:none; padding:0;">
                    ${artistRes.rows.map(a => `<li style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f9f9f9;"><span>${a.artist_name}</span><span style="color:#888;">${a.count}x</span></li>`).join('') || '<li>Nog geen likes</li>'}
                </ul>
            </div>
            <div style="text-align:center; margin-top:20px; padding-top:20px; border-top:1px solid #eee;">
                <button onclick="window.location.href='/leaderboard'" class="btn-start" style="margin-right:10px;">LEADERBOARD</button>
                <button onclick="window.location.href='/logout'" class="logout-link" style="padding:10px 20px; background:#fe8777; border:none; cursor:pointer; border-radius:25px; color:white;">LOGUIT</button>
            </div>
        </div>
    </main>
</body>
</html>`);
    } catch (e) { res.status(500).send("Fout"); }
});

app.listen(port, () => console.log(`Feest op poort ${port}`));
