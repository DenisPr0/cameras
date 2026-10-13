# cameras

Baza de camere ALPR (și camere de viteză) din OpenStreetMap pentru harta „Rută + camere” din extensia DenV1.

GitHub Actions rulează zilnic `scripts/build.mjs`, care descarcă camerele din SUA (+ sudul Canadei, Alaska, Hawaii, Puerto Rico) prin Overpass API și publică rezultatul pe ramura `data`:

- `https://raw.githubusercontent.com/DenisPr0/cameras/data/meta.json`
- `https://raw.githubusercontent.com/DenisPr0/cameras/data/cameras.tsv.gz`

Ramura `data` este suprascrisă la fiecare rulare (fără istoric), ca repo-ul să rămână mic.
Dacă numărul de camere scade brusc sub 90% din versiunea anterioară, publicarea se oprește; din tab-ul Actions se poate rula manual cu `force`.

Date © OpenStreetMap contributors, licență ODbL 1.0 — https://www.openstreetmap.org/copyright
