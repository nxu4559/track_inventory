const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set in Vercel environment variables');
  process.exit(1);
}

// Inject credentials into app.js
let appJs = fs.readFileSync('app.js', 'utf8');
appJs = appJs.replace(
  "var cfg = { url: '%%SUPABASE_URL%%', key: '%%SUPABASE_KEY%%' };",
  "var cfg = { url: '" + url + "', key: '" + key + "' };"
);

if (appJs.includes('%%SUPABASE_URL%%')) {
  console.error('ERROR: Credential placeholders still present in app.js');
  process.exit(1);
}

// Copy all files to dist
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/app.js',     appJs);
fs.copyFileSync('index.html',       'dist/index.html');
fs.copyFileSync('styles.css',       'dist/styles.css');

console.log('✓ Credentials injected into app.js');
console.log('✓ Build complete → dist/');