# Model discovery implementation plan

> Execute inline in the current session using the existing branch. No local Docker or additional agents.

**Goal:** Enter an API base URL and personal/platform key, fetch models, search/select a model, and save separately.

**Architecture:** A bounded authenticated POST endpoint resolves only the current user's credentials and calls a model discovery module. Reuse the HTTPS transport's DNS pinning, public-address validation, TLS verification and redirect rejection. A custom editable combobox displays returned models without storing credentials in the browser.

**Stack:** Node 24, existing SQLite store, vanilla JavaScript/CSS, node:test, native Safari and Chromium UI verification.

- [x] Write failing transport and endpoint tests for OpenAI-compatible, Anthropic and Gemini listings, pagination, invalid replies, status errors, private DNS, cancellation, timeout, account isolation, changed destination and rate/concurrency limits.
- [x] Extend the existing HTTPS transport to support GET; add `src/model-discovery.js` for normalized API roots, bounded pagination and safe error messages. Support compatible chat protocols for all three workspaces.
- [x] Add personal/admin discovery routes and credential resolution without saving, enabling or changing the active connection. Stored keys may only be reused for the same normalized API base URL. Add explicit `ALLOW_CUSTOM_API_HOSTS=true` deployment configuration while retaining HTTPS:443, public DNS, IP pinning and no redirects.
- [x] Add `public/model-control.js`: editable model field, fetch action, loading/empty/error states, searchable custom list, keyboard selection, cancellation and stale-result suppression. Keep the Safari height fix and allow manual model IDs.
- [x] Run targeted tests then the complete suite; exercise the real UI with disposable mock responses on desktop/mobile and Safari. Verify selection, manual fallback, changing credentials, failed fetch, stale fetch and tab/close cleanup.
- [ ] Update setup documentation, review the diff, commit/push, back up the existing remote database and submit the release through the platform. Allow only the intended env addition in the deployment manifest comparison. Verify published assets, health, data volume, secret versions and Safari. Stop/delete disposable local preview resources.

Acceptance: fetching models does not write provider settings, does not make paid generation calls, does not expose or borrow another user's/platform credential, and supports third-party public HTTPS endpoints with just an address and key. Listing a model does not claim its generation API has been tested. Existing manual configuration remains available.
