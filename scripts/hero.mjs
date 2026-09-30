#!/usr/bin/env node
/**
 * Iz `docs/37-GENESIS-BRAIN.html` izvlači SAMO scenu mozga i pravi čist hero fajl
 * (`docs/37b-BRAIN-HERO.html`) — bez panela, rama i trake, za naslovnu stranu sajta.
 *
 *   node scripts/hero.mjs
 *   node scripts/poster.mjs docs/37b-BRAIN-HERO.html site/assets/brain-hero.png 1400 980 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'docs/37-GENESIS-BRAIN.html'), 'utf8');

const style = src.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';
const brainStart = src.indexOf('<div class="brain float-slow">');
if (brainStart < 0) throw new Error('Ne nalazim .brain blok u izvoru');
const svgEnd = src.indexOf('</svg>', brainStart);
const brainEnd = src.indexOf('</div>', svgEnd) + '</div>'.length;
const brain = src.slice(brainStart, brainEnd);

// Skini `body::before/::after` (mreža + vinjeta) iz hero varijante — želimo čist mozak na prozirnoj podlozi
const overrides = `
  html,body{background:transparent !important}
  .stage{background:transparent !important;width:1400px;height:980px}
  .stage::before,.stage::after{display:none !important}
  .title{top:16px}
  .title p{letter-spacing:5px}
  .brain{top:110px;width:1240px;height:800px}
  .grain{opacity:.18}
`;

const title = '<div class="title"><h1>GENESIS BRAIN</h1><p>crystal glass · golden core · braincore pro v2.0</p><div class="rule"></div></div>';
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Genesis Brain — hero</title>
${style}
<style>${overrides}</style>
</head>
<body>
<div class="stage">${title}${brain}</div>
</body>
</html>`;

const out = path.join(ROOT, 'docs/37b-BRAIN-HERO.html');
fs.writeFileSync(out, html);
console.log(`OK: ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB, brain blok ${(brain.length / 1024).toFixed(1)} KB)`);
