# Changelog

## 0.3.0

- **MCP server**: `claude-image-gen mcp` with `generate_image`, `generate_video`, `list_accounts`, `check_accounts`
  and `login` tools. Images come back in the result so the model can see them; long videos send progress.
- **Claude Code plugin** now brings the MCP server along with the skill: one command installs both.
- **npm**: `npm install -g claude-image-gen`, or `npx -y claude-image-gen`.
- Fixed: two runs started at the same moment could crash with `ENOENT ... lock`, and two waiters could both take
  over a lock left by a dead run.
- Fixed: a batch prompt counted as done when a different prompt's file started with the same name, or when a video
  was saved for an image batch.
- Fixed: an empty download crashed the file-type check instead of being reported.
- Runs as root (in Docker) by passing Chrome `--no-sandbox` there.
- `~/.claude-image-gen`, which holds signed-in browser profiles, is now readable by its owner only.
- Tests: unit, lock stress, MCP protocol, and real-browser tests against a fake Flow page; CI on Node 22 and 24.

## 0.2.2

- `login` clears sign-ins a killed run left behind.

## 0.2.1

- Account filing is its own tested function; tests and CI on macOS, Windows and Linux.

## 0.2.0

- First release: images and videos from Google Flow, several accounts, batches, Claude Code plugin.
