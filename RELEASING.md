# Releasing

One process for every Captive Origins package:

1. Bump `version` in `package.json` (and the changelog, if any), commit as `Release x.y.z`, tag `vx.y.z`, and push the commit and the tag.
2. The Release workflow builds, tests and **stages** the version on npm (trusted publishing, no stored token).
3. The `captiveorigins` npm account approves it with 2FA: npmjs.com → avatar → **Staged Packages** → **Approve**, or `npm stage list` then `npm stage approve <id>`. Only then is it public.

The very first version of a new package is published by hand (`npm publish --access public`), because npm can only trust a workflow for a package that exists; then run once:

```bash
npm trust github <package-name> --repo mgilardi/<repo> --file release.yml --allow-stage-publish --yes
```
