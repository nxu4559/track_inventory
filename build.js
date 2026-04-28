require('dotenv').config();
const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';
const pin = process.env.APP_PIN || '1234';

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set');
  process.exit(1);
}

let appJs = fs.readFileSync('app.js', 'utf8');
appJs = appJs.replace("'%%APP_PIN%%'", "'" + pin + "'");
appJs = appJs.replace("url: '%%SUPABASE_URL%%'", "url: '" + url + "'");
appJs = appJs.replace("key: '%%SUPABASE_KEY%%'", "key: '" + key + "'");

fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/app.js', appJs);
fs.copyFileSync('index.html', 'public/index.html');
fs.copyFileSync('styles.css', 'public/styles.css');

console.log('✓ Build complete → public/');