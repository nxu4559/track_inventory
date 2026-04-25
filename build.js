const fs = require('fs');

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_KEY || '';

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY must be set in Vercel environment variables');
  process.exit(1);
}

let html = fs.readFileSync('index.html', 'utf8');

// Replace the entire async IIFE init block
const oldInit = `  try {
    showLoading();
    // Fetch credentials from Vercel serverless function
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Could not load config (/api/config returned ' + res.status + ')');
    const cfg = await res.json();
    if (!cfg.url || !cfg.key) throw new Error('Environment variables not set in Vercel');
    sbClient = window.supabase.createClient(cfg.url, cfg.key);`;

const newInit = `  try {
    showLoading();
    var cfg = { url: '${url}', key: '${key}' };
    sbClient = window.supabase.createClient(cfg.url, cfg.key);`;

if (html.includes("fetch('/api/config')")) {
  html = html.replace(oldInit, newInit);
  console.log('✓ Credentials injected');
} else {
  console.error('Could not find init block - check index.html');
  process.exit(1);
}

// Write output
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);

// Verify
if (fs.readFileSync('dist/index.html', 'utf8').includes("fetch('/api/config')")) {
  console.error('ERROR: fetch still present in output!');
  process.exit(1);
}
console.log('✓ Build complete → dist/index.html');