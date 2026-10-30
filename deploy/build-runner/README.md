# Cloud builds for app store releases

The Napkin Arcade server starts store releases as GitHub Actions runs in a private build repository:
Linux runners build Android, macOS runners build iOS. Nothing here holds creators' keys — each run pulls
its job from the server with a one-time token (3 hours) and reports every step back.

## One-time setup
1. Create a private repository (e.g. `your-org/napkin-builds`) containing:
   - `.github/workflows/release.yml` ← `deploy/build-runner/release.yml`
   - `release.mjs` ← `deploy/build-runner/release.mjs`
2. Create a fine-grained GitHub token with **Actions: Read and write** on that repository only.
3. Add to the server's `.env` and redeploy:
   ```
   BUILD_GITHUB_REPO=your-org/napkin-builds
   BUILD_GITHUB_TOKEN=github_pat_…
   ```

## Costs
GitHub bills runner minutes: Linux is cheap, **macOS is ~$0.08/min** (an iOS release is roughly 10–20 minutes).
Store accounts are the creator's: Google Play $25 once, Apple Developer $99/year.

## How a release flows
- **Android:** build → sign with the game's upload key (created on the first release, sealed on the server,
  downloadable by the creator) → the `.aab` goes back to the server → the server uploads it to the
  **internal testing** track with the creator's Play service account → the creator promotes it to production.
- **iOS:** build → automatic signing with the creator's App Store Connect API key → upload to App Store
  Connect → TestFlight processing → the creator submits it for App Review from the workshop.
