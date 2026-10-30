## 变更 / Change

<!-- State the concrete problem and resulting behavior. Link the issue if applicable. -->

## 验证 / Validation

<!-- Include focused tests, actual npm pack/install, and exact OS/runtime evidence. Distinguish native GUI from CI/service-only evidence. -->

- [ ] `npm run test:delivery` and relevant regression tests pass
- [ ] `npm run check:delivery` checks a real package installed outside the checkout
- [ ] `node desirecore/release.js --check` matches the reviewed fixed source bytes
- [ ] Timeline, API or MCP changes update `docs/editor-guide.md` and both root READMEs
- [ ] Permissions, lifecycle, data ownership, current runtime identity and explicit retry remain with their actual owners
- [ ] Native asset changes preserve fixed source URLs, original-byte SHA-256, license/source notices and all five target contracts
- [ ] Native GUI/export evidence is linked for each tested OS; untested boundaries are stated
- [ ] No test facilities, user media, provider credentials or upstream publication/announcement targets enter the payload
