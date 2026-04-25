const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set');
  process.exit(1);
}

let html = fs.readFileSync('index.html', 'utf8');

// Just find and replace the single fetch line - simpler and more reliable
if (!html.includes("fetch('/api/config')")) {
  console.error('ERROR: fetch line not found in index.html');
  process.exit(1);
}

// Replace the whole try block simply
html = html.replace(
  /showLoading\(\);[\s\S]*?sbClient = window\.supabase\.createClient\(cfg\.url, cfg\.key\);/,
  `showLoading();\n    var cfg = { url: '${url}', key: '${key}' };\n    sbClient = window.supabase.createClient(cfg.url, cfg.key);`
);

// Verify fetch is gone
if (html.includes("fetch('/api/config')")) {
  console.error('ERROR: fetch still present after replacement!');
  process.exit(1);
}

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
console.log('✓ Credentials injected and build complete');