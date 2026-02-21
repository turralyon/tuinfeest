require('dotenv').config();
const db = require('../db');
const axios = require('axios');

async function findGenresFromItunes(artistName) {
    try {
        const r = await axios.get('https://itunes.apple.com/search', {
            params: { term: artistName, entity: 'musicArtist', limit: 1 }
        });
        const res = r.data && r.data.results;
        if (Array.isArray(res) && res.length > 0 && res[0].primaryGenreName) return [res[0].primaryGenreName];
    } catch (e) {}
    return [];
}

async function findGenresFromMusicBrainz(artistName) {
    try {
        const r = await axios.get('https://musicbrainz.org/ws/2/artist/', {
            params: { query: `artist:${artistName}`, fmt: 'json', limit: 1 },
            headers: { 'User-Agent': 'tuinfeest-backfill/1.0 (example@example.com)' }
        });
        const artists = r.data && r.data.artists;
        if (Array.isArray(artists) && artists.length > 0) {
            const a = artists[0];
            if (a.tags && Array.isArray(a.tags) && a.tags.length > 0) {
                return a.tags.sort((x,y) => (y.count||0)-(x.count||0)).slice(0,3).map(t => t.name);
            }
        }
    } catch (e) {}
    return [];
}

async function backfill(limit = 500) {
    try {
        const rows = (await db.query("SELECT id, artist_name FROM history WHERE (genres IS NULL OR genres = '') AND artist_name IS NOT NULL LIMIT $1", [limit])).rows;
        console.log(`Found ${rows.length} rows to process`);
        for (const r of rows) {
            const name = r.artist_name;
            let genres = await findGenresFromItunes(name);
            if (!genres || genres.length === 0) genres = await findGenresFromMusicBrainz(name);
            if (genres && genres.length > 0) {
                const genresStr = genres.join(',');
                await db.query('UPDATE history SET genres = $1 WHERE id = $2', [genresStr, r.id]);
                console.log(`Updated id=${r.id} (${name}) -> ${genresStr}`);
            } else {
                console.log(`No genres found for id=${r.id} (${name})`);
            }
        }
        console.log('Backfill done');
        process.exit(0);
    } catch (e) {
        console.error('Backfill error', e);
        process.exit(1);
    }
}

backfill(1000);
