const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set in Vercel environment variables');
  process.exit(1);
}

let html = fs.readFileSync('index.html', 'utf8');

// Replace the entire fetch block with hardcoded values
const oldBlock = `    showLoading();
    // Fetch credentials from Vercel serverless function
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Could not load config (/api/config returned ' + res.status + ')');
    const cfg = await res.json();`;

const newBlock = `    showLoading();
    // Credentials injected at build time by build.js
    const cfg = { url: '${url}', key: '${key}' };`;

if (html.includes("fetch('/api/config')")) {
  html = html.replace(oldBlock, newBlock);
  console.log('✓ Credentials injected successfully');
} else {
  console.error('ERROR: Could not find fetch block in index.html');
  process.exit(1);
}

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
console.log('✓ Build complete → dist/index.html');