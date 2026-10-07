# Feat: Add Anonymous Requests and Repeater Region Discovery

**Issue Link:** [#43](https://github.com/meshcore-dev/meshcore.js/issues/43)

## Summary

Please add support for the Companion firmware's anonymous-request command (`CMD_SEND_ANON_REQ`, 57 / `0x39`), including a convenience method for querying a repeater's declared flood-allowed regions.

Related: [#16](https://github.com/meshcore-dev/meshcore.js/issues/16). That issue requests region support for channels/messages; this request specifically covers discovering the regions a repeater declares.

## Use case

I maintain a companion-based MeshCore observer that forwards captured packets to MQTT. Raw packets provide evidence of observed transport scopes, but do not supply repeaters' declared flood-allowed region lists.

Querying those declarations would allow applications to compare declared configuration with observed forwarding behavior and report region-discovery answers to consumers such as CoreScope.

Polling, persistence, and MQTT publication would remain application responsibilities. The library would provide the supported protocol operation.

## Current gap

In the current `master` implementation:

- `Constants.CommandCodes` does not include `SendAnonReq`.
- `Connection` has no anonymous-request method.
- `BinaryResponse` (`0x8C`) is already parsed, including its request tag and response bytes.
- `sendBinaryRequest()` uses a different firmware command, so it cannot directly substitute for an anonymous region request.

## Requested support

Suggested API names, subject to maintainer preference:

1. `Constants.CommandCodes.SendAnonReq = 57`.
2. An anonymous request-type constant for regions (`0x01`).
3. `sendCommandSendAnonReq(publicKey, requestCodeAndParams)` for command framing.
4. `sendAnonRequest(...)` for acknowledgement and tagged-response handling.
5. `getRegions(publicKey, ...)` for building the region request and parsing its answer.

The public key should follow the existing library convention of a 32-byte key.

An illustrative convenience API:

```js
const answer = await connection.getRegions(repeaterPublicKey);

// Proposed result:
// {
//   regions: ["*", "hu"],
//   repeaterClock: 1791388800
// }
```

Implementation in the shared `Connection` class should make the operation available across the existing Companion transports.

## Protocol behavior

For a region query requesting a zero-hop reply, the command payload is:

```text
[0x39][destination public key: 32 bytes][0x01][reply path length: 0]
```

The application does not supply the request timestamp/tag: the Companion firmware generates it.

The immediate `Sent` acknowledgement contains the routing result, request tag, and estimated timeout. A matching `BinaryResponse` carries the echoed tag, repeater clock, and region-name CSV.

The generic request API should expose enough acknowledgement metadata for callers to identify routing failures and correlate replies.

## Routing and compatibility

Repeaters only answer region requests delivered over a DIRECT route.

The zero-hop reply-path field does not force the outbound request to be zero-hop. The Companion selects the outbound route from the destination's contact state; an unknown saved route can cause a flood.

Please:

- Document the direct-route requirement.
- Report an unexpectedly flooded region request promptly instead of waiting for an answer that the repeater will not send.
- Avoid silently rewriting or resetting saved contact routes.
- Document firmware requirements and contact-table behavior, including unsupported commands and full-contact errors.
- Document serialized remote-request use where required by the firmware's pending-request state.

## Response and error handling

- Match replies to the tag from this request's acknowledgement.
- Continue waiting when an unrelated binary-response tag arrives.
- Bound both acknowledgement waiting and remote-response waiting.
- Remove listeners and timers on success, failure, timeout, or disconnection.
- Preserve useful firmware error codes.
- Reject malformed responses rather than interpreting them as empty answers.
- Remove trailing encryption NUL padding before decoding region names.
- Preserve region-name case and the `*` wildcard.
- Return `regions: []` for a successful empty answer; reject on timeout.
- Do not claim the returned list is definitely complete: the firmware can omit names when its response budget is exceeded without supplying a definitive truncation flag.

## Suggested validation

- Exact command framing and invalid input.
- Correct tag correlation, including an unrelated reply before the matching reply.
- Missing acknowledgement and missing remote reply.
- Disconnects and firmware errors.
- Direct versus flooded acknowledgements.
- Short or malformed replies.
- Empty answers, multiple regions, wildcard names, and trailing NUL padding.
- Listener cleanup after every completion path.
- A documented hardware check against compatible Companion and repeater firmware.

## Scope

This request covers anonymous-request support and parsing repeater region answers. It does not require MQTT support, application polling schedules, storage, repeater management authentication, or region configuration changes.

Would this be an acceptable scope for a contribution, and are there preferred API names or response shapes?

## Implementation Plan

### 1. Feature Summary

- Add Companion anonymous-request command support and a `Connection` convenience method that requests and parses a repeater's declared flood-allowed regions.
- Keep the operation transport-independent by implementing it in the shared `Connection` class. The library reports a single query result; polling, persistence, and publication remain with calling applications.

### 2. Relevant Existing Architecture

- `src/constants.js` centralizes command, response, push, error, and binary-request codes. `BinaryResponse` and the existing binary request types are already defined there.
- `src/connection/connection.js` owns command framing, Companion frame dispatch, `Sent` acknowledgement parsing, `BinaryResponse` event parsing, `sendBinaryRequest()`, and `getNeighbours()`.
- Each transport (`web_ble_connection.js`, `web_serial_connection.js`, `serial_connection.js`, `nodejs_serial_connection.js`, and `tcp_connection.js`) subclasses or uses the shared `Connection`; the feature should not add transport-specific code.
- `src/events.js` provides the project's small asynchronous event emitter. The existing request helpers register listeners and timeouts locally. `Connection` also emits `disconnected` when a transport closes.
- `examples/` contains standalone Node examples for repeater status, telemetry, and neighbours. `README.md` is the package's short public guide.
- No test files or usable test runner are present in the checkout. `package.json` has only a placeholder `test` script, so the test approach and supported Node baseline need maintainer alignment before adding tooling.

### 3. Proposed Approach

- Add `SendAnonReq` and the region request type to `Constants`, then add `sendCommandSendAnonReq()` beside the other command-framing methods. Validate the destination public key as 32 bytes and frame the command as command byte, key, and request bytes. For region discovery, those request bytes are `[0x01][reply path length: 0]`; the firmware supplies the timestamp/tag. The minimum verified Companion version is v1.12.0, and the destination must already be in its contact table with a direct route. This feature will not add the contact or alter its route.
- Preserve the existing `sendBinaryRequest()` implementation and return shape. Add `sendAnonRequest()` beside it using the same event-listener and timeout pattern, returning `{ acknowledgement, responseData }`; the acknowledgement carries `result`, request tag, and estimated timeout. This keeps the change additive and avoids refactoring a working API. Match only the acknowledgement tag, continue past unrelated binary responses, enforce separate acknowledgement and response deadlines, and clean up listeners and timers on every outcome, including disconnect.
- Implement `sendAnonRequest()` for acknowledgement and tagged-response handling, and implement `getRegions()` to issue request type `0x01` with a zero-hop reply path and parse the repeater clock plus CSV region names. The repeater's raw reply prefixes the request timestamp and clock, but the Companion strips the echoed timestamp/tag before emitting `BinaryResponse`, so `responseData` starts with the 4-byte repeater clock followed by the CSV. Reject truncated or malformed payloads, remove only trailing NUL padding before decoding, preserve case and `*`, and accept a valid empty CSV as `regions: []`.
- Detect and reject an acknowledgement indicating a flooded route (`Sent.result === 1`) before waiting for a response; a direct acknowledgement is `Sent.result === 0`. Do not alter the saved contact route. Document direct routing, firmware/contact-table constraints, serialized remote-request use, and the fact that a response may omit regions when firmware response space is exhausted.
- Add focused automated tests using a dependency-free test facility if it is compatible with the package's supported Node versions; otherwise use the maintainers' existing preferred test harness. Add a hardware verification procedure for compatible Companion and repeater firmware.

### 4. Impacted Areas

- `src/constants.js` â€” anonymous command and region request constants.
- `src/connection/connection.js` â€” command frame, tagged acknowledgement/response coordination, input and response validation, region convenience method, and disconnect/error cleanup.
- `README.md` and a focused example under `examples/` â€” API usage, direct-route requirement, firmware/contact-table behavior, serialized-use note, and incomplete-answer caveat.
- New test files and `package.json` test script only after confirming the repository's Node baseline and maintainer test convention.
- No transport modules, storage, polling, MQTT, authentication, or region-configuration changes are expected.

### 5. Task Breakdown

#### T1: Define anonymous-request constants and command framing

- Objective: Add the protocol identifiers and exact Companion command payload for anonymous requests.
- Specific changes: Add `Constants.CommandCodes.SendAnonReq = 57` and a region request type constant with value `0x01`; implement `sendCommandSendAnonReq(publicKey, requestCodeAndParams)` in `Connection`; reject non-32-byte destination keys and malformed request data before sending.
- Definition of done: The emitted frame matches `[0x39][32-byte key][request bytes]`; for region discovery, request bytes are exactly `[0x01][0x00]`. No timestamp or request tag is generated by JavaScript.
- Expected tests / validation: Assert exact bytes for valid input and rejection for invalid key length or missing request bytes. Confirm the expected framing against the Companion firmware definition.

#### T2: Add acknowledgement-aware tagged anonymous request handling

- Objective: Coordinate the local `Sent` acknowledgement with the later `BinaryResponse` safely.
- Specific changes: Add `sendAnonRequest()` as an additive method following the existing `sendBinaryRequest()` event pattern; leave `sendBinaryRequest()` unchanged. Return `{ acknowledgement, responseData }`; reject send errors with their firmware error code, reject flooded routing, ignore unrelated response tags, and bound acknowledgement and remote-response waits separately. Remove listeners and clear timers on success, error, timeout, send failure, and disconnect.
- Definition of done: A request is correlated only with the tag from its own acknowledgement; an unrelated response does not end the wait; the public result exposes enough acknowledgement metadata to diagnose routing; the existing binary-request API remains backward compatible.
- Expected tests / validation: Cover direct and flooded acknowledgement results, firmware errors, missing acknowledgement, missing matching response, unrelated response before matching response, disconnect, send failure, both timeouts, and listener/timer cleanup. Verify existing `sendBinaryRequest()` callers still receive response bytes.

#### T3: Parse repeater region answers in `getRegions()`

- Objective: Provide a narrow convenience method for discovering declared regions.
- Specific changes: Build the versionless region request (`0x01`) with zero-hop reply path; parse the response clock and CSV; strip trailing NUL padding; preserve region casing and wildcard entries; return an empty array for a valid empty list; reject short, inconsistent, or malformed responses rather than returning partial/empty data.
- Definition of done: `getRegions(publicKey)` returns the agreed object shape, including the repeater clock and parsed region names, and timeout remains an error. Document that the answer is not guaranteed complete when firmware omits entries due to its response-size budget.
- Expected tests / validation: Cover no regions, one and multiple names, mixed case, `*`, trailing NUL padding, truncated clock/data, malformed CSV/encoding, timeout, and 32-byte key validation.

#### T4: Run Companion hardware validation

- Objective: Validate the end-to-end anonymous region request against one unsupported and one supported Companion firmware version.
- Specific changes: Store a manual JavaScript hardware validation script at `docs/tests/anon-regions-hardware.mjs`. On unsupported v1.11.0, verify `getRegions()` rejects with the Companion `UnsupportedCmd` error. On supported v1.12.0, ensure the repeater is present with a direct route (add a temporary contact only if absent), verify the returned clock and expected region names, then remove and verify removal of any temporary contact. Keep this device-dependent check out of the automated `npm test` command.
- Definition of done: The unsupported and supported hardware checks produce the expected outcomes, and any temporary contact is removed and verified absent.
- Expected validation: Record Companion firmware build identifiers, error/result data, and contact cleanup evidence for the PR summary. This local smoke test does not replace a future repository test suite; adding one still depends on confirming the maintainers' Node baseline and test convention.
- Validation evidence: COM4 Companion v1.11.0 build `v1.11.0-6d32193` returned `UnsupportedCmd` (error code 1). Companion v1.12.0 build `v1.12.0-e738a74` returned clock `1791386051` and regions `*`, `us-oh`, `cvg`, `us-midwest`, `oki`, and `day`; the temporary direct contact was removed and verified absent. The repeatable manual check is available at `docs/tests/anon-regions-hardware.mjs` and is not part of the automated test command.

#### T5: Document usage and compatibility limits

- Objective: Make operational constraints clear to library consumers and record the local compatibility evidence.
- Specific changes: Add a small example following the existing repeater examples and update `README.md` or the example comments with API usage, the v1.12.0 minimum verified Companion version, the existing-contact/direct-route prerequisite, unsupported-command and not-found errors, serialized remote-request use, and response completeness limitation. Explain that unknown saved routes can flood and that callers must update routing themselves if needed. Do not promise automatic insertion of unknown destinations or contact-table-full behavior as part of this feature.
- Definition of done: A consumer can tell how to issue one query, interpret route/error outcomes, and understand when the result may be incomplete. No saved contact route is silently rewritten or reset.
- Expected tests / validation: Review docs against the final API and use the T4 hardware results as compatibility evidence. Do not repeat a flooded-route hardware test unless it can be done without causing unintended mesh traffic.

### 6. Risks and Edge Cases

- Current [Companion protocol documentation](https://github.com/meshcore-dev/MeshCore/wiki/Companion-Radio-Protocol) defines `Sent.result` as `1` for flood and `0` for direct. Confirm this against the minimum supported Companion firmware during implementation; `MSG_SEND_FAILED` is reported separately as a firmware error.
- `sendBinaryRequest()` currently hides acknowledgement metadata and waits for the matching tagged response after `Sent`; changing its public return value would break callers. Keep it unchanged and implement the anonymous-request flow additively, following the repository's existing per-operation event handling pattern.
- The event emitter defers callbacks with `setTimeout()`, and the existing `once()` wrapper is not removable by passing the original callback to `off()`. Cleanup should account for these semantics; concurrent remote requests may also compete for uncorrelated `Sent` acknowledgements.
- The minimum verified Companion version for this feature is v1.12.0, with the destination already present in the contact table and configured for a direct route. On v1.12.0, an unknown destination returned `NotFound`; v1.11.0 returned `UnsupportedCmd`. Current [Companion firmware source](https://github.com/meshcore-dev/MeshCore/blob/main/examples/companion_radio/MyMesh.cpp) allows anonymous requests to unknown destinations at protocol code 13+ by adding a contact, but the firmware release mapping is not established. Automatic contact insertion and contact-table-full behavior are outside this feature; preserve firmware errors and document the verified prerequisite.
- The [repeater region handler](https://github.com/meshcore-dev/MeshCore/blob/repeater-v1.12.0/examples/simple_repeater/MyMesh.cpp) expects request data to start with the reply-path length after the request type, prefixes its raw reply with the request timestamp and repeater clock, and exports names subject to its response buffer budget. The Companion strips the echoed timestamp/tag before emitting `BinaryResponse`, so the library's `responseData` starts with the repeater clock and CSV. The tested repeater's firmware version was not identified, so do not claim a minimum repeater firmware unless a version is established during implementation.
- The repeater requires a direct inbound request to answer, even though the reply path length is zero. Unknown saved routes may cause Companion flooding. The API must report this promptly and must not modify contact routing state.
- A syntactically valid answer may be incomplete if firmware response budget is exceeded and provides no truncation indicator. The API must not claim completeness.
- There is no current automated test infrastructure or declared supported Node version in `package.json`; adding a runner/script should follow maintainer conventions and avoid a dependency change unless approved.
- The T4 Companion smoke test requires physical hardware and is not part of the automated test command; it does not provide CI coverage for framing, parser edge cases, or cleanup paths. Any automated repository test suite remains dependent on confirming the maintainers' Node baseline and test convention.

### 7. Resolved Decisions and Remaining Assumptions

#### Resolved decisions

- Companion compatibility: document v1.12.0 as the minimum verified version, with the destination already in the contact table and configured for a direct route. On COM4, v1.11.0 (protocol code 8) returned `UnsupportedCmd` before sending a mesh request. On v1.12.0 (also protocol code 8), an unknown destination returned `NotFound` without sending a mesh request or changing contact/route state. After explicit approval, a temporary direct contact was added and the query succeeded. The repeater returned clock `1791383916` and regions `*`, `us-oh`, `cvg`, `us-midwest`, `oki`, and `day`; the temporary contact was removed and the table returned to zero entries. The repeater firmware version was not identified, so this is hardware evidence for the behavior, not a repeater-version floor.
- Unknown destinations: automatic contact insertion and contact-table-full behavior are outside this feature. Current Companion source supports an unknown destination at protocol code 13+, but its firmware release mapping is not established and is not needed for the agreed support boundary. Preserve firmware errors such as `UnsupportedCmd` and `NotFound`.
- API compatibility: implement the operation additively in shared `Connection`, preserving `sendBinaryRequest()` and its existing return shape. Keep transport-specific changes out of scope.
- Request overlap: callers serialize remote requests by awaiting each result before starting another; document that callers must not overlap these requests with `Promise.all()`. Do not add a queue or overlap guard. Any library-wide concurrency policy needs maintainer coordination because it could affect existing request APIs and consumers.
- Routing: repeater region discovery requires a direct inbound request. Do not rewrite/reset the saved contact route. Detect the route from the `Sent` acknowledgement and reject a flooded route before waiting for a response. Upstream protocol documentation says `Sent.result` is `1` for flood and `0` for direct; the COM4 probe did not retain the numeric acknowledgement, so confirm this mapping against the implementation's supported firmware. A flooded hardware case has not been exercised.

#### Remaining assumptions or maintainer decisions

- Public API names and result shapes remain proposed for upstream review: `sendAnonRequest()` returning `{ acknowledgement, responseData }`, plus `getRegions()` returning `{ regions, repeaterClock }`. They follow existing `sendBinaryRequest()`, `getNeighbours()`, and `getStatus()` naming without changing existing callers.
- This checkout declares neither a supported Node version (`engines`) nor a functioning test script. Confirm the supported Node baseline and test convention with maintainers before adding a runner or changing `package.json`.
- Use the repository's established byte-input convention for public keys and validate that the key is exactly 32 bytes. The plan currently assumes `Uint8Array`/Buffer-compatible input; confirm this against existing public methods when implementing.
- No minimum repeater firmware has been established. The available hardware query succeeded, but the repeater firmware version was not recorded.

### 8. Suggested Execution Order

1. T1 â€” establish constants and exact wire framing first.
2. T2 â€” make acknowledgement, route, tag, timeout, error, and disconnect behavior reliable before exposing a parser.
3. T3 â€” add the region-specific request and strict response parser on top of the waiter.
4. T4 — run the Companion hardware checks on v1.11.0 and v1.12.0 using `docs/tests/anon-regions-hardware.mjs`.
5. T5 — document the public contract and record the T4 compatibility evidence.


