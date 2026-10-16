# Output token limits and long responses

Execute inline on the existing branch; no subagents and no local Docker. User accepted removing the arbitrary 4096 cap and correcting the response deadline.

Goal: accept user-selected positive safe-integer output budgets; retain existing saved budgets, use 8192 for new connections, show verified model-list metadata when supplied, and let long requests survive the gateway's 60-second idle timeout.

Architecture: reuse existing provider validation and parameter mapping. Normalize explicit output metadata (Gemini outputTokenLimit, Anthropic max_tokens, compatible gateways max_output_tokens); never use context length as output capacity. Model picker reports metadata to the token field and invalidates it when connection/model changes. The provider enforces actual limits; UI metadata is a current-list hint, not a security boundary. Provider timeout defaults to 300 seconds and is configurable from 10 to 1800 seconds. Chat responses send JSON whitespace every 15 seconds, disable proxy buffering and serialize errors with an explicit status after headers have been sent. Normal quick responses retain HTTP status semantics. Keep generation and discovery limits separate.

- [x] Add failing tests for large budgets and invalid numeric values, 8192 new defaults and existing-budget preservation, normalized metadata, configurable deadlines, heartbeat JSON/error handling, and large saved budgets reaching the adapter.
- [x] Update providers/config/store/personal defaults and expose timeout setting. Increase chat transport body limit to 8 MiB, keep discovery 2 MiB and 20 seconds. Keep bounded output storage and request concurrency.
- [x] Add `src/json-heartbeat.js`, finish JSON after heartbeats, handle safe timeout/parameter errors and stream-envelope errors in `public/ui-lib.js`. Test cleanup, disconnect, delayed success/failure and retained authentication checks.
- [x] Wire model metadata into the output field; remove fixed max, preserve manual values, mark exceeded known limits, remove stale metadata on connection edits/requery. Verify saved larger values, unknown metadata, search/keyboard and mobile layout with temporary fixtures.
- [ ] Run full suite and syntax/diff checks, update operator docs/validation, commit and push. Back up production DB, deploy through existing platform with only timeout env added, compare assets/TLS/health/data/secret versions and clean disposable local resources.

References checked 2026-10-16: https://platform.claude.com/docs/en/api/models/list ; https://ai.google.dev/api/models ; https://developers.openai.com/api/reference/resources/models/methods/list . OpenAI's basic model catalogue does not advertise a uniform output limit; don't fabricate one.

Local validation complete: 179 tests pass; native Safari and 390x844 browser checks pass. Remote platform 0.7.0 validated the timeout-only manifest delta. Final deployment and cleanup evidence is stored outside the source checkout to avoid a post-deployment source change.
