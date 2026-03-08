const pool = require('../db');
const bcrypt = require('bcrypt');
require('dotenv').config();

async function main() {
  let client;
  try {
    client = await pool.connect();

    const usersRes = await client.query('SELECT username FROM users');
    console.log('Huidige gebruikers:', usersRes.rows.map(r => r.username));

    const histRes = await client.query('SELECT COUNT(*) FROM history');
    console.log('Aantal history-rijen vóór opschoning:', histRes.rows[0].count);

    // Verwijder alle history rows
    await client.query('DELETE FROM history');
    console.log('✅ Alle rijen in `history` verwijderd.');

    // Verwijder alle users behalve admin
    await client.query("DELETE FROM users WHERE username != 'admin'");
    console.log('✅ Alle gebruikers behalve `admin` verwijderd.');

    // Controleer of admin bestaat, anders maken met wachtwoord uit env of gegenereerd wachtwoord
    const adminRes = await client.query("SELECT * FROM users WHERE username = 'admin'");
    if (adminRes.rowCount === 0) {
      const envPass = process.env.ADMIN_PASSWORD;
      const adminPass = envPass && envPass.length > 0 ? envPass : (Math.random().toString(36).slice(-10) + 'A1!');
      const hashed = await bcrypt.hash(adminPass, 10);
      await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', ['admin', hashed]);
      console.log('⚠️ `admin` bestond niet. Nieuwe admin aangemaakt met wachtwoord:');
      console.log(adminPass);
    } else {
      console.log('`admin` bestaat al — wachtwoord niet aangepast.');
    }

    const usersAfter = await client.query('SELECT username FROM users');
    console.log('Gebruikers na opschoning:', usersAfter.rows.map(r => r.username));

  } catch (e) {
    console.error('Fout tijdens opschonen:', e.message || e);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    // sluit pool netjes
    try { await pool.end(); } catch (e) {}
  }
}

main();
