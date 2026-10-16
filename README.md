# Swarm message card QA evidence

Source: seven-mile/paseo, `swarm/ui-swarm-system-envelopes`, commit `2ca204543d0003f6f3d3bfea47b888d75a805b9b`.

The screenshots come from the real app components compiled through the production Metro module graph. A test-owned HTML document mounts the components; this is a browser component/gallery check, not a live daemon or a complete conversation timeline.

## Visual evidence

| Image | Observed scope |
| --- | --- |
| [Wide light card](screenshots/1280-light-team.png) | Expanded Team message with generated agent and Task references |
| [Wide hover](screenshots/1280-light-hover.png) | Current viewport: visible Task underline |
| [Wide keyboard focus](screenshots/1280-light-focus.png) | Current viewport: existing link focus outline |
| [Dark runtime card](screenshots/1280-dark-runtime.png) | Runtime notification, generated agent references and authored Markdown Task link |
| [Narrow hover](screenshots/390-light-hover.png) | 390 px browser viewport, 350 px message column |
| [Narrow original](screenshots/390-dark-original.png) | Shared card frame and expanded plain original text |

## Checks

- [Markdown parser](logs/markdown-parser.log): 38 tests passed.
- [Canonical provider](logs/canonical-provider.log): 29 tests passed. New cases use production parsed tokens and the shared link hook/provider/resolver with a test-owned transport and a mocked typed destination adapter. This verifies dispatch, not a live destination panel.
- [DOM Range](logs/dom-ranges.log): 6 tests passed.
- [Presentation](logs/presentation.log): 74 tests passed in the card candidate. Source bytes are unchanged by the reference-link refinement.
- [Browser component](logs/component.log): one case passed, including two complete Copy API writes, Find, attachments, keyboard disclosure, and shared-card geometry. Its fixture/spec are unchanged by the link refinement; Copy was not rerun for that refinement.
- [Normal commit hooks](logs/commit-hooks.log): scoped formatting and lint plus root workspace typecheck passed. Checkout paths are replaced with `<checkout>`; remaining output is preserved.

[Gallery raw results](gallery-results.json) record four browser variants: 1280/390 × light/dark. Every variant completes the link, Find, hover, focus, hostless activation, original-text and geometry assertions. Hostless generated references are consumed locally. This does not prove live Task/agent navigation.

Two preceding gallery attempts failed during hover observation: the first omitted the nonleaf Text owning the decoration; the second captured an element screenshot that could scroll the link away from the pointer. The successful run changes only capture diagnostics to current-viewport screenshots and preserves the product and assertion gates. These earlier failures remain in the local audit record.

## Limits

CJK text visibly renders missing-glyph boxes on the Linux test host. Native devices, Electron, full conversation timeline, live destination panels, stock CI workflow, OS clipboard readback, and positive WebSocket traffic are untested. The images show browser components, not native-device screenshots. No claim is made that every browser child process was individually sampled during cleanup.
