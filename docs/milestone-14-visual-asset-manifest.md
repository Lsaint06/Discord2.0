# Milestone 14 — visual asset manifest

**No third-party or downloaded visual assets are used.** Every theme, ambient artwork,
decoration, effect, banner preset and name style is original work written for Discord 2.0 as
CSS, inline SVG (inside CSS `data:` URLs or JSX) or Canvas drawing code. No images, Lottie or
Rive files, icon packs or fonts were added. No Discord artwork was copied, traced or extracted.

SVG is used only as inline markup authored in this repository: no remote SVG, no user-supplied
SVG and no scripts. The CSP (`img-src 'self' data: blob:`) is unchanged.

## Source files that contain the artwork

SHA-256 values are truncated to 16 characters and were taken at the end of the session.

| File | Bytes | SHA-256 (first 16) |
| --- | --- | --- |
| `desktop/src/renderer/src/assets/themes.css` | 17629 | `5DC99AE96ADADCAD` |
| `desktop/src/renderer/src/assets/profile-style.css` | 24162 | `16ECB9DA19C18872` |
| `desktop/src/renderer/src/lib/themes.ts` | 16234 | `EE7551241F91EB63` |
| `desktop/src/renderer/src/lib/profileStyle.ts` | 7279 | `B005EBA28042A4A5` |
| `desktop/src/renderer/src/components/profile/AvatarDecoration.tsx` | 16694 | `2B0B50F20508D082` |
| `desktop/src/renderer/src/components/profile/ProfileEffect.tsx` | 10080 | `035D5627D3326F69` |
| `desktop/src/renderer/src/components/profile/BannerArt.tsx` | 548 | `AA872C08DB94BAA2` |

## Inventory

| Kind | Count | Ids (registry: `net/protocol.ts`) | Technique | Author / license |
| --- | --- | --- | --- | --- |
| App themes | 12 | `obsidian` Midnight Obsidian, `cyber` Cyber Neon, `sakura` Sakura Dream, `aurora` Aurora Borealis, `void` AMOLED Void, `solar` Solar Flare, `abyss` Ocean Abyss, `amethyst` Royal Amethyst, `glass` Frosted Glass, `synthwave` Retro Synthwave, `forest` Forest Canopy, `mint` Mint Frost | Palettes as CSS variables; gradient backdrop; one ambient art layer each (glossy glint, circuit grid, drifting petals, aurora ribbons, none (OLED), sun flare and lens ghosts, caustics and light shafts, gold lattice, frosted grain, striped sun and moving grid, leaves and dapples, ripples) | Original, Discord 2.0 |
| Avatar decorations | 12 | `violet-halo`, `celestial-ring`, `frost-shards`, `neon-pulse`, `pixel-hearts`, `petal-fall`, `star-orbit`, `ember-sparks`, `circuit-trace`, `moon-orbit`, `prism-ribbon`, `cosmic-comet` | Inline SVG with CSS keyframes (spin, twinkle, pulse, bob, fall, rise, light along traces); unique per-instance gradient ids | Original, Discord 2.0 |
| Profile effects | 8 | `aurora-shimmer`, `neon-wave`, `holo-scan` (CSS); `meteor-shower`, `sakura-drift`, `galaxy-dust`, `golden-sparks`, `winter-snow` (Canvas, ≤ 150 particles) | Bounded: 4.5 s per play; still frame under reduced motion | Original, Discord 2.0 |
| Banner presets | 8 | `aurora`, `starfield`, `waves`, `sunset`, `nebula`, `grid`, `bokeh`, `prism` | CSS gradients and inline SVG patterns; animate only while the profile is active | Original, Discord 2.0 |
| Name styles | 6 | `gradient`, `gold`, `silver`, `neon`, `aurora`, `holo` | `background-clip: text` gradients; light-theme variants; plain text under high contrast | Original, Discord 2.0 |
| Profile gradient presets | 8 | Twilight, Lagoon, Ember, Forest, Candy, Midnight, Peach, Aurora (`lib/profileStyle.ts`) | 2–3 stop linear gradients | Original, Discord 2.0 |

## User-supplied media (not bundled)

Users can upload their own profile pictures and banners (static or animated GIF/WebP) and
soundboard clips. Uploads are processed by the server and never bundled with the app:

- **Images:** decoded and re-encoded by sharp. Metadata is stripped; frames and pixels are
  bounded.
- **Soundboard clips:** must be validated 16-bit PCM WAV.

Their rights are the uploader's responsibility, as with any chat attachment.
