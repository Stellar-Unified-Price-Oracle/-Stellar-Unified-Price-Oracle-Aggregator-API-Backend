# Feed catalog releases

Immutable, signed catalog releases live here as `v<N>.json`. They are written by
`scripts/feed-catalog-release.mjs`; see
[`docs/FEED_CATALOG_RELEASES.md`](../../docs/FEED_CATALOG_RELEASES.md).

Do not edit or delete a published artifact. A correction is a new version whose
`previousCatalogHash` points at the version it supersedes. Private signing keys
are never stored in this directory.
