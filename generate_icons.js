const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

function svgForSize(size) {
  const fontSize = size * 0.44;
  const circleRadius = size * 0.42;
  const center = size / 2;
  const baselineY = center + fontSize * 0.34;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${center}" cy="${center}" r="${circleRadius}" fill="#ff944d"/>
  <text
    x="50%"
    y="${baselineY}"
    text-anchor="middle"
    font-family="'Segoe UI', Arial, sans-serif"
    font-size="${fontSize}"
    font-weight="400"
    fill="#ffffff"
  >S</text>
</svg>`;
}

for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(iconsDir, `icon${size}.svg`), svgForSize(size), 'utf8');
  console.log(`Created icon${size}.svg`);
}

console.log('Sharp SVG icon set generated in ./icons/');
