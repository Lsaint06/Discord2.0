# Discord 2.0 built-in sounds

Every file in this folder is original work made for Discord 2.0. They are rendered by
`desktop/scripts/sounds/render-sounds.mjs` using procedural synthesis: FM bells, plucked
strings, kalimba tines, chiptune pulse waves, synth plucks and filtered noise. No samples,
recordings or third-party sound libraries are used, and no Discord sounds were referenced or
copied.

They ship as part of the Discord 2.0 application under the project's own terms.

`manifest.json` records each file's SHA-256 hash, duration and objective audio measurements
(loudness, peak, DC offset, silence and clipping). Running `node scripts/sounds/render-sounds.mjs
--check` confirms that the files are byte-identical to a fresh render.
