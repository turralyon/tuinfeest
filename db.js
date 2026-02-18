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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);

    // Gebruikers toevoegen als ze er nog niet zijn
    const res = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(res.rows[0].count) === 0) {
      const defaultUsers = [
        ['admin', 'Spelletjes2026!'],
        ['Ans', 'F33stjeAns'],
        ['Theo', 'Th3oFeEstJ#'],
        ['Gonnie', 'g0NnieF3est'],
        ['Antoon', 'F33sT18Jul!'],
        ['Linda', 'L!nD@F3est'],
        ['Carolien', 'G3woontHu!s'],
        ['Rene', 'ByP@sca!&Car0l1eN'],
        ['Vincent', 'S!tt@Rd6137KH'],
        ['Elke', 'Bi3sB0scHsTr@@t8']
      ];

      for (const [user, pass] of defaultUsers) {
        const hashedPass = await bcrypt.hash(pass, 10);
        await client.query('INSERT INTO users (username, password) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, hashedPass]);
      }
      console.log("✅ Gastenlijst succesvol geïmporteerd naar Neon!");
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

initDb();

module.exports = pool;