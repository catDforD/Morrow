# Pinned Cordis runtime

`cordis/src` and `cosmokit/src` are unmodified copies from
deepseek-ai/deepseek-harness commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`.
Both MIT licenses are retained in their package directories.

Local modifications: package manifests omit optional DSH include/loader peers;
Morrow's build creates `lib/index.js` using esbuild. Vendor tsconfigs emit declarations
without checking the upstream implementation; Morrow's own packages use strict checking.
The plugin framework itself is unchanged. To update, compare the pinned source,
replace both packages together, then run lifecycle, DI and cross-language tests.
