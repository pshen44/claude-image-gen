# Contributing

Thanks for helping. The whole tool is one file, [claude-image-gen.js](claude-image-gen.js), with no dependencies.
Keep it that way: Node's built-ins only.

## Run it from a checkout

```bash
node claude-image-gen.js --help
node claude-image-gen.js login
node claude-image-gen.js image "a red barn"
node claude-image-gen.js mcp            # the MCP server; or: npx @modelcontextprotocol/inspector node claude-image-gen.js mcp
```

## Tests

```bash
npm test                                 # everything
node --test test/browser.test.js         # just the browser tests
BROWSER_PATH=/path/to/chrome npm test    # a browser that isn't found on its own
```

| File | Covers | Needs |
|---|---|---|
| `test/cli.test.js` | arguments, models, file names, batches, file types, switching accounts | nothing |
| `test/lock.test.js` | the lock that queues parallel runs, hammered by several processes | nothing |
| `test/accounts.test.js` | filing a signed-in profile under its email | nothing |
| `test/mcp.test.js` | the MCP server, spoken to the way a client does | nothing |
| `test/browser.test.js` | the browser driving: page states, settings popup, prompt, new tiles, both downloads, errors | a Chromium-based browser (skipped without one) |

The browser tests run against [test/fixtures/flow.html](test/fixtures/flow.html), a stand-in for a Flow project page
with the same labels, roles and `aria-label`s. **When Flow changes its page**, update the fixture to match what Flow
now shows, watch the browser tests fail, then fix the selectors in `JS` in claude-image-gen.js until they pass.
Then check it once against the real Flow.

## Releasing

```bash
node scripts/bump.js 0.4.0       # the version in every file, and the Homebrew formula's URL and sha256
git commit -am "0.4.0: ..." && git tag v0.4.0 && git push && git push --tags
```

Pushing the tag runs [.github/workflows/release.yml](.github/workflows/release.yml): it checks the version, runs the
tests, publishes to npm with provenance and creates the GitHub Release. It needs an `NPM_TOKEN` repository secret.
Add a line to [CHANGELOG.md](CHANGELOG.md) for anything people will notice.
