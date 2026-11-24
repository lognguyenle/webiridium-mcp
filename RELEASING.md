# Releasing

## First release (one time, by hand)

npm only lets you set up trusted publishing for a package that already exists,
so the first version is published from your computer.

1. Sign in to npm (create an account at https://www.npmjs.com/signup if needed):

   ```
   npm login
   ```

2. Check what will be published (should be `server.mjs`, `README.md`,
   `LICENSE`, `package.json`):

   ```
   npm pack --dry-run
   ```

3. Publish:

   ```
   npm publish --access public
   ```

4. Turn on trusted publishing so later releases come from GitHub Actions:
   on npmjs.com open the package → **Settings** → **Trusted Publisher** →
   **GitHub Actions**, and enter:
   - Organization or user: `lognguyenle`
   - Repository: `webiridium-mcp`
   - Workflow filename: `publish.yml`

   Optionally, in the same settings page, set publishing access to
   "Require two-factor authentication and disallow tokens".

## Later releases

1. Bump the version and push the tag:

   ```
   npm version patch   # or minor / major
   git push --follow-tags
   ```

2. On GitHub, create a release from that tag (`v0.1.1`, etc.). Publishing the
   release runs `.github/workflows/publish.yml`, which tests and publishes to
   npm with provenance.
