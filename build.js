// Vercel build script — replaces placeholders with real env vars
const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set in Vercel environment variables');
  process.exit(1);
}

// Read index.html
let html = fs.readFileSync('index.html', 'utf8');

// Replace the init section to inject credentials directly
html = html.replace(
  "const cfg = await res.json();",
  `const cfg = { url: '${url}', key: '${key}' };`
);
html = html.replace(
  "const res = await fetch('/api/config');\n    if (!res.ok) throw new Error('Could not load config (/api/config returned ' + res.status + ')');",
  "// credentials injected at build time"
);

// Write to dist folder
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);

console.log('✓ Build complete - credentials injected');