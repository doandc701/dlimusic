# shared/

Files used by both the web version (`public/`, `web/`) and the app (`mobile/`), kept once here.

- `assets/cat-headphones.webp` — the start screen's cat (web: `/img/cat-headphones.webp`)
- `assets/cat-dance-grid.webp` — the dancing kittens, 3x13 frames of 320x224 (web: `/img/cat-dance-grid.webp`)
- `assets/silence.wav` — 2 s of silence: keeps the music going between songs with the screen locked
  (web: `/sounds/silence.wav`; app: the keeper player)

The web keeps its URLs: `server.js` (`SHARED_ASSETS`) serves these files under them, `web/build.mjs` copies them
there. The app `require()`s them from here (Metro watches the whole repository).
Code shared the same way stays where it was: `core.js`, `web/cloud-sync.js`.
