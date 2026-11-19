# Release workflow

The user has authorized pushing, deploying, and applying required database migrations as part of site changes. Complete the release after implementing and verifying changes; do not stop at local edits or ask for release permission again.

- Apply required migrations to Supabase project `tmixrlodofdycichecyj` before deploying code that needs them. Preserve existing shop records.
- Push verified changes to this repository's `origin` on the intended branch.
- Deploy Vercel project `videvas-cosmetics-site` in scope `videvascosmetics-1868`, using the workspace credentials in `data/vercel-auth`.
- Verify the live release and report any access or service failure accurately. Never claim a migration, push, or deployment succeeded without checking its result.
- Keep credentials, environment files, and local browser data out of commits.
