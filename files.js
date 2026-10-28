'use strict';

/* Список файлов флота: по нему service worker (sw.js) кэширует всё для работы
   без интернета, а Гавань собирает архив «Скачать ZIP». Новый файл — добавить сюда. */

const FLEET_VERSION = '2026-10-28';
const FLEET_FILES = [
  'index.html', 'hub.css', 'hub.js',
  'photo.html', 'app.js',
  'animka.html', 'animka.js',
  'kontur.html', 'kontur.js',
  'svet.html', 'svet.js',
  'kadr.html', 'kadr.js',
  'volna.html', 'volna.js',
  'verstka.html', 'verstka.js',
  'suite.js', 'ui.js', 'files.js', 'sw.js', 'style.css', 'manifest.webmanifest',
  'logo.svg', 'icon-fleet.svg', 'icon-animka.svg', 'icon-kontur.svg', 'icon-svet.svg',
  'icon-kadr.svg', 'icon-volna.svg', 'icon-verstka.svg', 'icon-192.png', 'icon-512.png',
  'README.md', 'LICENSE',
];
