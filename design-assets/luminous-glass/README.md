# Luminous Glass source

`expression-source.png` is the generated nine-expression sheet for the mature male glass orb approved in this conversation. It is the source used by the approved standalone MP4 demonstrations. The v2 demonstration added stronger head turns, tilts, nods, and drift.

The web implementation reuses this identity and motion direction with bounded 2.5D turns. It does not replay the MP4. Runtime texture preparation lives in `ops/build-orb-assets.py`; the prepared PNGs are shipped from `client/public/orb-packs/luminous-glass/`.

See `docs/ORB-PACKS.md` for the replaceable artwork contract and its current limitations.
