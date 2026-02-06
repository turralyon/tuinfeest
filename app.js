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
            \${showSwipe ? \`<div>
                \${user.username === 'admin' ? '<a href="/admin" style="color:white; margin-right:15px; text-decoration:none;">ADMIN</a>' : ''}
                <a href="/logout" style="color:white; text-decoration:none;">LOGUIT</a>
            </div>\` : ''}
        </header>

        <main>
            \${!showSwipe ? \`
                <div class="login-card">
                    <div class="login-header-main">Het is tijd voor!</div>
                    <div class="login-header-sub">muziek</div>
                    <input type="text" id="u" placeholder="Naam">
                    <input type="password" id="p" placeholder="Wachtwoord">
                    <button onclick="doLogin()" class="btn-start">LET'S GO</button>
                    <p id="msg" style="color:#ff6b6b; font-size:0.8rem; margin-top:10px;"></p>
                </div>
            \` : \`
                <div class="tinder-container" id="tinderContainer"></div>
                <div class="controls">
                    <button class="circle-btn btn-nope" onclick="forceSwipe('left')">✖</button>
                    <button class="circle-btn btn-like" onclick="forceSwipe('right')">❤</button>
                </div>
            \`}
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

            let trackList = []; let currentIndex = 0;
            async function loadTracks() {
                try {
                    const r = await fetch('/api/tracks');
                    const d = await r.json();
                    trackList = [...trackList, ...d];
                    if (currentIndex === 0 && trackList.length > 0) renderCard();
                } catch(e) { console.error('Load failed:', e); }
            }

            function renderCard() {
                const container = document.getElementById('tinderContainer');
                if (!container) return;
                if (currentIndex >= trackList.length - 2) loadTracks();
                
                const t = trackList[currentIndex];
                if (!t) {
                    container.innerHTML = '<p style="text-align:center;">Geen nummers meer...</p>';
                    return;
                }

                container.innerHTML = '<div class="track-card" id="activeCard">' +
                    '<div class="stamp stamp-like">LIKE</div>' +
                    '<div class="stamp stamp-nope">NOPE</div>' +
                    '<iframe src="https://open.spotify.com/embed/track/' + t.id + '?utm_source=generator" ' +
                    'width="100%" height="352" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>' +
                    '<div class="swipe-zone"></div>' +
                    '</div>';
                
                setupHammer();
            }

            function setupHammer() {
                const el = document.getElementById('activeCard');
                if(!el) return;
                const hammer = new Hammer(el.querySelector('.swipe-zone'));
                hammer.on('pan', (ev) => {
                    el.style.transition = 'none';
                    el.style.transform = 'translateX(calc(-50% + ' + ev.deltaX + 'px)) rotate(' + (ev.deltaX / 15) + 'deg)';
                });
                hammer.on('panend', (ev) => {
                    if (ev.deltaX > 140) handleSwipe('like');
                    else if (ev.deltaX < -140) handleSwipe('nope');
                    else {
                        el.style.transition = '0.3s';
                        el.style.transform = 'translateX(-50%)';
                    }
                });
            }

            function forceSwipe(dir) { handleSwipe(dir === "right" ? "like" : "nope"); }

            async function handleSwipe(action) {
                const t = trackList[currentIndex];
                const el = document.getElementById('activeCard');
                if(el) {
                    el.style.transition = '0.4s';
                    el.style.transform = action === 'like' ? 'translateX(200%)' : 'translateX(-200%)';
                    el.style.opacity = '0';
                }
                fetch('/api/interact', { 
                    method: 'POST', 
                    headers: {'Content-Type': 'application/json'}, 
                    body: JSON.stringify({ 
                        track_id: t.id, 
                        action: action, 
                        uri: t.uri,
                        track_name: t.name,
                        artist_name: t.artists[0].name
                    }) 
                });
                currentIndex++;
                setTimeout(renderCard, 350);
            }

            if (document.getElementById('tinderContainer')) loadTracks();
        </script>
    </body>
    </html>
    `);
});