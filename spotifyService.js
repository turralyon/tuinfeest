const axios = require('axios');

let accessToken = null;
let tokenExpiresAt = 0;

async function refreshIfNeeded() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    
    try {
        const response = await axios.post('https://accounts.spotify.com/api/token', 
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: process.env.SPOTIFY_REFRESH_TOKEN.trim()
            }), {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID.trim() + ':' + process.env.SPOTIFY_CLIENT_SECRET.trim()).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        accessToken = response.data.access_token;
        tokenExpiresAt = Date.now() + (response.data.expires_in * 1000);
        return accessToken;
    } catch (e) {
        console.error("❌ Spotify Refresh Error:", e.response?.data || e.message);
        return null;
    }
}

module.exports = { refreshIfNeeded };