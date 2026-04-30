// Build script: extract <script type="text/babel"> from index.html,
// compile JSX with esbuild, output Babel-free dist/index.html
const esbuild = require('esbuild');
const fs = require('fs');

const src = fs.readFileSync('index.html', 'utf-8');

const babelTagRe = /<script\s+type="text\/babel">([\s\S]*?)<\/script>/;
const m = src.match(babelTagRe);
if (!m) { console.error('ERROR: <script type="text/babel"> not found'); process.exit(1); }

const { code } = esbuild.transformSync(m[1], {
  loader: 'jsx',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  target: 'es2017',
  minify: false,
});

const dist = src
  .replace(/<script src="https:\/\/cdnjs\.cloudflare\.com[^"]*babel[^"]*"><\/script>\n?/, '')
  .replace(babelTagRe, `<script>\n${code}</script>`);

fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', dist, 'utf-8');
console.log('✓ dist/index.html (Babel-free)');
