# Release checklist

- [ ] `npm test` passes in `server/`.
- [ ] Manifest, popup, content script, and server package use the same version.
- [ ] `node scripts/verify-icon-lock.js` confirms the approved Feishu icon set.
- [ ] No personal paths, credentials, tokens, Base IDs, document IDs, email addresses, or private URLs are present.
- [ ] Extension ZIP has `manifest.json` at its archive root.
- [ ] Companion ZIP includes server, installers, privacy policy, and installation guide.
- [ ] Privacy URL points to the public repository's `PRIVACY.md`.
- [ ] Support URL points to the public repository's Issues page.
- [ ] Chrome Privacy answers match `privacy-practices.md`.
- [ ] Edge Privacy answers match `privacy-practices.md`.
- [ ] Local companion dependency is disclosed in both store descriptions.
- [ ] Reviewer notes contain complete setup and test steps.
- [ ] 1280x800 screenshot, 440x280 promotional tile, 300x300 logo, and 128x128 icon are uploaded.
- [ ] GitHub release contains both ZIP files and checksums.
- [ ] Chrome and Edge submissions are sent for review only after all listing sections are complete.
