// 把地图和视频播放器的库从 node_modules 复制到 public/vendor，网站就不依赖外部 CDN。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['node_modules/maplibre-gl/dist/maplibre-gl.js', 'public/vendor/maplibre-gl.js'],
  ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'public/vendor/maplibre-gl.css'],
  ['node_modules/hls.js/dist/hls.min.js', 'public/vendor/hls.min.js'],
  // 网站上传照片时用：读取拍摄时间/GPS、把 iPhone 的 HEIC 转成 JPG
  ['node_modules/exifr/dist/lite.umd.js', 'public/vendor/exifr-lite.umd.js'],
  ['node_modules/heic2any/dist/heic2any.min.js', 'public/vendor/heic2any.min.js'],
  // 网站上传视频时用：在浏览器里把视频压缩成 720p MP4
  ['node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', 'public/vendor/mediabunny.min.mjs'],
];

mkdirSync(join(root, 'public/vendor'), { recursive: true });
for (const [from, to] of files) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.warn(`[vendor] 跳过，未找到 ${from}（还没装依赖？）`);
    continue;
  }
  copyFileSync(src, join(root, to));
  console.log(`[vendor] ${from} -> ${to}`);
}
