const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';
const pin = process.env.APP_PIN || '1234';

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set');
  process.exit(1);
}

let appJs = fs.readFileSync('app.js', 'utf8');

// Inject credentials
appJs = appJs.replace(
  "var cfg = { url: '%%SUPABASE_URL%%', key: '%%SUPABASE_KEY%%' };",
  "var cfg = { url: '" + url + "', key: '" + key + "' };"
);

// Inject PIN
appJs = appJs.replace("'%%APP_PIN%%'", "'" + pin + "'");

if (appJs.includes('%%SUPABASE_URL%%') || appJs.includes('%%APP_PIN%%')) {
  console.error('ERROR: Placeholders still present!');
  process.exit(1);
}

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/app.js', appJs);
fs.copyFileSync('index.html', 'dist/index.html');
fs.copyFileSync('styles.css', 'dist/styles.css');

console.log('✓ Credentials + PIN injected');
console.log('✓ Build complete → dist/');