const { Pool } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Dit is nodig voor de beveiligde Neon verbinding
  }
});

const initDb = async () => {
  let client;
  try {
    client = await pool.connect();
    console.log("🐘 Verbonden met de Neon Database: tuinfeest");

    // Tabellen aanmaken
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        token TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS history (
        id SERIAL PRIMARY KEY,
        username TEXT,
        track_id TEXT,
        action TEXT,
        track_name TEXT,
        artist_name TEXT,
        genres TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    // Voeg genres kolom toe als deze nog niet bestaat (voor bestaande databases)
    await client.query(`
      ALTER TABLE history ADD COLUMN IF NOT EXISTS genres TEXT
    `);

    // Uitnodigingen tabel aanmaken
    await client.query(`
      CREATE TABLE IF NOT EXISTS invitations (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Gebruikers toevoegen als ze er nog niet zijn
    const res = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(res.rows[0].count) === 0) {
      // Alleen admin gebruiker aanmaken
      const hashedPass = await bcrypt.hash('Spelletjes2026!', 10);
      await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', ['admin', hashedPass]);
      console.log("✅ Admin gebruiker aangemaakt!");
    } else {
      // Upgrade plaintext passwords to bcrypt hashes
      const plainUsers = await client.query('SELECT id, password FROM users WHERE password NOT LIKE $1', ['$2%']);
      for (const user of plainUsers.rows) {
        const hashedPass = await bcrypt.hash(user.password, 10);
        await client.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPass, user.id]);
      }
      if (plainUsers.rows.length > 0) {
        console.log(`✅ ${plainUsers.rows.length} wachtwoorden gehashed naar bcrypt`);
      }
    }
  } catch (err) {
    console.error("❌ Database Error:", err.message);
  } finally {
    if (client) client.release();
  }
};

module.exports = { pool, initDb };