# Releasing

Every version is published to npm by the `captiveorigins` npm account, from a maintainer's machine, so npm lists `captiveorigins` as the publisher. Nothing publishes from CI.

1. Bump `version` in `package.json` (and the changelog, if any), commit as `Release x.y.z`, tag `vx.y.z`, push the commit and the tag.
2. Publish while signed in to npm as `captiveorigins` (2FA prompt):

   ```bash
   git pull && npm publish --access public
   ```

   `prepublishOnly` runs the typecheck and tests; `prepack` builds.
