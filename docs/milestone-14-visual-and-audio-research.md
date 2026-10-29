# Milestone 14 — visual and audio research

Retrieved on 2026-10-28 with the Chrome DevTools MCP browser (pages opened and text read in this
session) unless marked otherwise. Discord's features were studied as **concepts only**. No
Discord artwork, audio or code was copied, downloaded or traced.

## Sources read in the browser

| # | Source | What it says (relevant part) | Adopted | Rejected |
| --- | --- | --- | --- | --- |
| 1 | Discord Support — Avatar Decorations FAQ, <https://support.discord.com/hc/en-us/articles/13410113109911> | Decorations are cosmetic frames chosen under Profiles → Change Decoration and confirmed with Save Changes. They are bought in the Shop, with Nitro perks. | A selectable frame around the avatar, chosen in the profile editor and committed with Save. One decoration per account. | Shop, purchases and any paywall. Discord's decoration artwork. |
| 2 | Discord Support — Profile Effects, <https://support.discord.com/hc/en-us/articles/17828465914263> | "Animated effects that play on your profile when someone views your profile". Bought in the Shop, applied in Profiles. | The effect plays when a profile is opened and replays on hover. Selection is saved with the profile and visible to others. | Shop and paywall. Endless looping (ours are bounded; see WCAG below). |
| 3 | Discord Support — How to Change Discord Color Themes…, <https://support.discord.com/hc/en-us/articles/207260127> | Light/Ash/Dark/Onyx/Sync themes. Nitro custom themes with up to 5 gradient colors, a Gradient Direction slider and Color Intensity. Non-subscribers can preview but not apply. | **Preview before applying** (our gallery shows the theme across the whole app, with Apply/Cancel). A **direction slider** for profile gradients. Light-theme variants (Sakura, Frosted Glass, Mint). | The paywall (all our themes are free). Arbitrary 5-color app gradients: we ship 12 curated themes whose text contrast is tested, so a theme can't make the app unreadable. |
| 4 | Discord — Nitro page, <https://discord.com/nitro> | Nitro advertises "animated avatars, banner images, profile themes", "20+ app color themes" and custom profiles. | All of these as free features: animated avatars and banners, profile gradients ("profile themes"), 12 app themes. | Tier names, badges and upsells. |
| 5 | GitHub — airbnb/lottie-web, <https://github.com/airbnb/lottie-web> | MIT license. Renders After Effects animations. | — | Not needed: all our animations are small CSS/SVG/Canvas, so no runtime dependency or JSON animation files were added. |
| 6 | GitHub — tsparticles/tsparticles, <https://github.com/tsparticles/tsparticles> | MIT license. Particle engine. | — | Not needed: five bounded canvas scenes (≤ 150 particles, < 5 s) were simpler and smaller than a dependency. |
| 7 | GitHub — motiondivision/motion, <https://github.com/motiondivision/motion> | MIT license. Animation library. | — | Not needed: CSS transitions/keyframes cover the UI. |
| 8 | MDN — prefers-reduced-motion, <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion> | Lets apps reduce non-essential motion. Scaling or panning large objects can trigger vestibular discomfort. | The app's existing reduced-motion setting (or the Windows setting) stops all theme ambient motion, decorations, effects, animated pictures and banners. Ambient layers move slowly with small amplitude. | Large zoom or pan effects. |
| 9 | W3C — Understanding SC 2.2.2 Pause, Stop, Hide, <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html> | Motion that starts automatically, lasts more than 5 s and runs in parallel with other content needs a way to pause, stop or hide it. | Profile effects play for 4.5 s (tested < 5 s). Continuous ambient theme motion can be stopped with Settings → Appearance → Theme Effects: Reduced, or with reduced motion. Decorations in lists animate only on hover. | Endless autoplay without a control. |
| 10 | W3C — Understanding SC 2.3.1 Three Flashes or Below Threshold, <https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html> | Nothing may flash more than 3 times per second. | All cycles are ≥ 1.8 s; there are no strobing or full-surface flashes. | — |
| 11 | Kenney — Support, <https://kenney.nl/support> | Kenney's game assets are CC0 (public domain). | Recorded as a CC0 source for future packs. | Not used this milestone: no downloads were needed. |
| 12 | Chrome for Developers, <https://developer.chrome.com/> | Read only to confirm the Chrome DevTools MCP browser worked. | — | — |

## Standards used without browsing them this session

- **ITU-R BS.1770 K-weighting** loudness measurement, using the standard 48 kHz pre-filter and
  RLB high-pass coefficients. Used by the sound renderer's QA. Applied from existing knowledge
  and not re-read in the browser today.
- **WCAG 2.x contrast ratio** (relative luminance formula). Used by the theme and profile
  contrast tests.

## Design decisions

- **Original identity.** Themes, decorations, effects, banner art and sounds were all designed
  in code for this project: CSS, inline SVG, Canvas and procedural audio. None of it imitates
  Discord's specific artwork or sounds; only the general ideas (a ring around the avatar, an
  effect when a profile opens, app color themes) are shared.
- **Everything free.** There is no shop, no tiers and no gating, except where the server
  simply doesn't support a feature yet (API 6 is needed to share profile styles).
- **No new runtime dependencies.** Lottie, tsParticles and Motion (all MIT) were evaluated and
  not adopted. That keeps the installer size, attack surface and license list unchanged.
- **No downloaded assets.** On request, the owner allowed free non-commercial assets, but none
  were needed. All 12 themes, 12 decorations, 8 effects, 8 banner presets and 144 sounds are
  original. The visual asset manifest therefore lists only first-party sources.
- **Audio.** Notification sounds are short, tonal and non-fatiguing: FM bells and plucks with a
  soft room, a gentle low-pass and loudness matching per event class (alerts above standard
  above controls). Paired cues mirror each other (join rises and leave falls; mute and unmute
  point down and up). Push-to-talk cues are off by default because they can be distracting.
