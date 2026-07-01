'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSETS_DIR = path.join(__dirname, 'assets');
const FONTS_DIR = path.join(ASSETS_DIR, 'fonts');

// Ensure directories exist
fs.mkdirSync(FONTS_DIR, { recursive: true });

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch ${url}, status code: ${res.statusCode}`));
      }
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url} -> ${dest}`);
  const data = await fetchUrl(url);
  fs.writeFileSync(dest, data);
}

async function main() {
  try {
    // 1. Download Anime.js
    const animeUrl = 'https://cdnjs.cloudflare.com/ajax/libs/animejs/3.2.1/anime.min.js';
    await downloadFile(animeUrl, path.join(ASSETS_DIR, 'anime.min.js'));

    // 2. Fetch Google Fonts CSS to extract .woff2 urls
    const fontCssUrl = 'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;600&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500';
    console.log(`Fetching font CSS: ${fontCssUrl}`);
    const cssBuffer = await fetchUrl(fontCssUrl, { 'User-Agent': CHROME_UA });
    const cssContent = cssBuffer.toString('utf8');

    // Parse the CSS
    // Example:
    // @font-face {
    //   font-family: 'Inter';
    //   font-style: normal;
    //   font-weight: 400;
    //   font-display: swap;
    //   src: url(https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZhrib2Bg-A.woff2) format('woff2');
    //   unicode-range: U+0460-052F, U+1C80-1C88, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F;
    // }
    
    // We want to find each font-family, weight, and url.
    // For simplicity, we can regex split the css blocks and match the unicode-range for latin or common ones,
    // or just grab the urls for font-family + weight.
    const fontFaceBlocks = cssContent.split('}');
    const downloadMap = new Map(); // key: family-weight, value: url

    for (const block of fontFaceBlocks) {
      if (!block.trim()) continue;
      const familyMatch = block.match(/font-family:\s*'([^']+)'/);
      const weightMatch = block.match(/font-weight:\s*(\d+)/);
      const urlMatch = block.match(/url\((https:\/\/[^)]+\.woff2)\)/);
      // We only care about latin subset. Google Fonts lists subsets with comments like /* latin */
      // Let's check if the block contains U+0000-00FF (which is the basic latin unicode-range) or if the comment before it says /* latin */
      const isLatin = block.includes('U+0000-00FF') || block.includes('/* latin */');

      if (familyMatch && weightMatch && urlMatch && isLatin) {
        const family = familyMatch[1].replace(/\s+/g, '');
        const weight = weightMatch[1];
        const url = urlMatch[1];
        const key = `${family}-${weight}`;
        if (!downloadMap.has(key)) {
          downloadMap.set(key, url);
        }
      }
    }

    console.log(`Found ${downloadMap.size} fonts to download.`);
    for (const [key, url] of downloadMap.entries()) {
      const dest = path.join(FONTS_DIR, `${key}.woff2`);
      await downloadFile(url, dest);
    }

    console.log('All assets downloaded successfully!');
  } catch (err) {
    console.error('Error downloading assets:', err);
    process.exit(1);
  }
}

main();
