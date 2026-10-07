<h1 align="center">claude-image-gen</h1>

<p align="center">
  <strong>Free AI images and videos for Claude and other AI agents, from your own Google Flow account.</strong><br>
  Nano Banana for images. Veo and Omni Flash for video. An MCP server, a Claude Code plugin and a CLI.<br>
  Headless, one file, no dependencies, no API key.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-image-gen"><img src="https://img.shields.io/npm/v/claude-image-gen?style=flat" alt="npm"></a>
  <a href="#mcp-server"><img src="https://img.shields.io/badge/MCP-server-8A2BE2?style=flat" alt="MCP server"></a>
  <a href="#install"><img src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-supported-blue?style=flat" alt="macOS, Windows, Linux"></a>
  <a href="#claude-code"><img src="https://img.shields.io/badge/Claude_Code-plugin-orange?style=flat" alt="Claude Code plugin"></a>
  <a href="https://github.com/pshen44/claude-image-gen/actions/workflows/test.yml"><img src="https://github.com/pshen44/claude-image-gen/actions/workflows/test.yml/badge.svg" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat" alt="MIT"></a>
</p>

<p align="center">
  <img src="docs/demo.gif" width="760" alt="claude-image-gen making an image and a video from the terminal">
</p>

<p align="center">
  <a href="#see-it">See it</a> ·
  <a href="#install">Install</a> ·
  <a href="#mcp-server">MCP</a> ·
  <a href="#use-it">CLI</a> ·
  <a href="#models-and-costs">Models</a> ·
  <a href="#signing-in">Signing in</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## See it

You ask Claude for a picture. Claude runs one command. The file lands in your project.

```text
> make a watercolor fox reading under a mushroom for the blog header

● claude-image-gen image "a tiny watercolor fox reading a book under a mushroom" -o blog/header
  image | Nano Banana 2 | 16:9 | x1 | free
  /home/you/site/blog/header.jpg
```

<table>
<tr>
<td width="33%"><img src="docs/fox.jpg" alt="Watercolor fox reading under a mushroom"><br><sub><code>image "a tiny watercolor fox reading a book under a mushroom"</code></sub></td>
<td width="33%"><img src="docs/mug.jpg" alt="Blue ceramic mug on a wooden desk"><br><sub><code>image "a blue ceramic mug on a wooden desk, product photo" -m nano-banana-pro -a 1:1</code></sub></td>
<td width="33%"><img src="docs/lighthouse.gif" alt="Drone shot of a lighthouse at sunset"><br><sub><code>video "a lighthouse on a cliff at sunset, waves crashing, drone shot" -m veo-lite</code></sub></td>
</tr>
</table>

Each one came straight out of the command under it, unedited (the GIF is cut down from the 8-second MP4).

## Install

You need **Node.js 22+** and any **Chromium-based browser** (Chrome, Edge, Brave or Chromium; every Windows PC has Edge).

### Claude Code: one command

```bash
claude plugin marketplace add pshen44/claude-image-gen && claude plugin install flow-image-gen@flow-image-gen
```

The plugin brings the [MCP server](#mcp-server) (`generate_image`, `generate_video` and account tools) and a skill
that teaches Claude every model, option and error. Then just ask: *"make a watercolor fox for the blog header"*.
The first time, Claude opens a Google sign-in window for you; sign in and it carries on.

### Any MCP client (Claude Desktop, Cursor, Windsurf, VS Code, ...)

```bash
claude mcp add claude-image-gen -- npx -y claude-image-gen mcp     # Claude Code without the plugin
```

For clients configured with JSON (Claude Desktop's `claude_desktop_config.json`, Cursor's `mcp.json`, ...):

```json
{
  "mcpServers": {
    "claude-image-gen": { "command": "npx", "args": ["-y", "claude-image-gen", "mcp"] }
  }
}
```

### Command line

```bash
npm install -g claude-image-gen
claude-image-gen login                                       # sign in once (a browser window opens)
claude-image-gen image "a red barn under a blue sky, flat illustration"
```

**The Google account has to belong to someone 18 or older.** That's Google's rule for Flow.

<details>
<summary>Other ways to install</summary>

```bash
# macOS (Homebrew; installs Node.js for you)
brew tap pshen44/claude-image-gen https://github.com/pshen44/claude-image-gen && brew trust pshen44/claude-image-gen && brew install claude-image-gen

# macOS / Linux, without npm (installs Node.js through Homebrew if it's missing)
curl -fsSL https://raw.githubusercontent.com/pshen44/claude-image-gen/main/install.sh | sh
```

```powershell
# Windows (PowerShell; installs Node.js through winget if it's missing)
irm https://raw.githubusercontent.com/pshen44/claude-image-gen/main/install.ps1 | iex
```

Or skip installing: the whole tool is [one file](claude-image-gen.js). Download it and run `node claude-image-gen.js`,
or run `npx -y claude-image-gen` with any command.

Using an agent without MCP? It works anywhere a model can run a terminal command. Point the agent at
[skills/claude-image-gen/SKILL.md](skills/claude-image-gen/SKILL.md).

Uninstall: `npm uninstall -g claude-image-gen`, `brew uninstall claude-image-gen`, or delete `~/.local/share/claude-image-gen`
and `~/.local/bin/claude-image-gen` (macOS/Linux) or `%LOCALAPPDATA%\claude-image-gen` (Windows). Your accounts live in
`~/.claude-image-gen`; delete that too.

</details>

## MCP server

`claude-image-gen mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. It is the same
single file with no dependencies; the protocol is implemented directly.

| Tool | Arguments | Returns |
|---|---|---|
| `generate_image` | `prompt`, and optionally `model`, `aspect_ratio`, `count` (1-4), `output`, `account`, `preview` | The saved paths, and the images themselves so the model can look at them |
| `generate_video` | The same, plus `duration` and `resolution` (omni-flash only) | The saved paths, and the credits spent |
| `list_accounts` | | The signed-in Google accounts |
| `check_accounts` | `account` | Whether each account is still signed in |
| `login` | | Opens a sign-in window on your screen and waits for you |

- **Where files go:** give `output` an absolute path (Claude does). Relative paths and the default go to
  `CIG_OUTPUT_DIR` if set, otherwise the folder the client started the server in, or `~/claude-image-gen` when that
  folder isn't writable (desktop apps).
- **Errors** come back as tool results that start with a code (`not_signed_in`, `out_of_credits`, `refused`,
  `rate_limited`, `busy`) and say what to do next, so the model can recover on its own.
- **Long videos** send progress notifications (model, cost, what Flow is doing), which also keep clients from timing out.
- Calls are queued, so a model firing several at once gets them one after another.

## Use it

The command line does everything the MCP tools do, plus batches.

```bash
claude-image-gen image "<prompt>"                        # one image, saved in the current folder
claude-image-gen image "<prompt>" -o art/cover            # choose the file name (the extension is added for you)
claude-image-gen image "<prompt>" -a 9:16 -n 4            # four portrait images from one prompt
claude-image-gen image "<prompt>" -m nano-banana-pro      # a different model
claude-image-gen video "<prompt>"                         # an 8-second 720p video with Omni Flash
claude-image-gen video "<prompt>" -d 4s -r 360p           # the cheapest video
claude-image-gen video "<prompt>" -m veo-fast -a 9:16     # a vertical Veo clip
claude-image-gen batch prompts.txt -o images              # one image per line of prompts.txt
claude-image-gen batch prompts.txt -o clips --video       # one video per line
claude-image-gen accounts                                 # your Google accounts; see Signing in
```

| Option | Values |
|---|---|
| `-o, --out` | Output file, or folder for `batch` |
| `-m, --model` | See [models](#models-and-costs) |
| `-a, --aspect` | Images: `16:9` (default) `4:3` `1:1` `3:4` `9:16`. Videos: `16:9` (default) `9:16` |
| `-n, --count` | `1` to `4` from one prompt (files get `-1`, `-2`, ... on the end) |
| `-d, --duration` | Omni Flash only: `4s` `6s` `8s` (default) `10s` |
| `-r, --resolution` | Omni Flash only: `360p` `720p` (default) |
| `--show` | Show the browser window instead of running headless |
| `--account` | Use only this account (its number from `accounts`, or its email) |
| `--browser` | `chrome` `edge` `brave` `chromium` (default: the one the account signed in with) |

**Batch files** have one prompt per line. Blank lines and lines starting with `#` are skipped. Run the same batch again and it skips everything already saved, so a run that stopped halfway picks up where it left off. It stops early after 3 failures in a row.

Saved file paths go to stdout, one per line, and progress goes to stderr, so scripts can use the output directly: `open "$(claude-image-gen image 'a cat')"`.

## Models and costs

| Kind | `-m` | Flow's name | Cost | Notes |
|---|---|---|---|---|
| Image | `nano-banana-2` (default) | Nano Banana 2 | free | |
| Image | `nano-banana-pro` | Nano Banana Pro | free | Best quality and text rendering |
| Image | `nano-banana-2-lite` | Nano Banana 2 Lite | free | Fastest |
| Video | `omni-flash` (default) | Omni 1.1 Flash | 4 to 15 credits | The only model where you choose the length (4/6/8/10s) and resolution (360p/720p). 4s at 360p is the cheapest. |
| Video | `veo-lite` | Veo 3.1 - Lite | 10 to 12 credits | Always 8s at 720p |
| Video | `veo-fast` | Veo 3.1 - Fast | 20 credits | Always 8s at 720p |
| Video | `veo-quality` | Veo 3.1 - Quality | 100 credits | Always 8s at 720p |

These were the prices at the time of writing. Google changes them, so the tool reads the live price from Flow and prints it (`uses 7 Flow credits`) before every video. Videos come with sound.

The model flags match Flow's menu by pattern, so when Google ships Veo 3.2 the same `veo-fast` flag picks it up. You can also pass Flow's exact label: `-m "Veo 3.1 - Fast"`.

## Signing in

```bash
claude-image-gen login        # sign in once; run it again to add more Google accounts
claude-image-gen accounts     # see them
```

```text
Accounts (runs use the active one; if it is signed out, out of credits or rate-limited, the next is tried):
  1. you@gmail.com  (active)
  2. you.second@gmail.com
```

Every `login` adds a Google account, for example a personal and a work account. Runs use the active one; if Google has signed it out, or it can't run this generation right now, the next account is tried. Keep within the limits Google sets for each account.

| Command | What it does |
|---|---|
| `claude-image-gen login` | Add an account. Sign in to one you already added to refresh it. |
| `claude-image-gen accounts` | List accounts and show which one is active. |
| `claude-image-gen use 2` | Make account 2 the one runs start with (a number or an email). |
| `claude-image-gen logout 2` | Remove account 2. With no number, removes the active one. |
| `claude-image-gen status` | Check that every account is still signed in. |
| `--account 2` | Use only account 2 for this one command. |

- **Google signs accounts out now and then.** The tool never fails silently: it says `NOT SIGNED IN: Google signed you@gmail.com out of Flow. Run "claude-image-gen login" and sign in as you@gmail.com` and exits with code `2`. Through MCP, Claude calls the `login` tool for you and asks you to sign in in the window that opens.
- **Each account must belong to someone 18 or older**, and Flow has to be offered in your country. If it isn't, the tool says so.
- **The tool never sees your password.** You type it into Google's own page. Each account gets its own private browser profile in `~/.claude-image-gen/accounts`, kept apart from your normal browser.

## What happens on your screen

Nothing. Everything except `login` runs in a **headless** browser, with no window and no tab. It uses **one** tab and closes the browser as soon as the command finishes, so nothing keeps running in the background. If two commands start at once (agents love doing that), the second waits its turn instead of fighting over the browser.

## Exit codes

Agents can branch on these.

| Code | Meaning |
|---|---|
| `0` | Saved. The paths are on stdout. |
| `1` | Something else went wrong. The message says what. |
| `2` | Not signed in. Run `claude-image-gen login`. |
| `3` | Another run held the browser for 15 minutes. |
| `4` | Out of Flow credits on every account. They refill daily; images still work. |
| `5` | Flow refused the prompt. The message quotes Flow. |
| `6` | Rate-limited on every account. Nothing was charged; wait and retry. |

Codes `2`, `4` and `6` only happen once every account has been tried.

## Troubleshooting

| You see | Do this |
|---|---|
| `NOT SIGNED IN` | `claude-image-gen login` |
| `RATE LIMITED: ... unusual activity` | Google's limit on many generations in a short time. Nothing was charged. Wait; it can take a few hours. |
| `OUT OF CREDITS` | Wait for the daily refill, or pick a cheaper video setting (Omni Flash at 4s/360p). Images still work. |
| `Flow refused or failed: "..."` | Usually a content policy hit. Rephrase the prompt (no real people, logos or unsafe content). |
| `No Chromium-based browser found` | Install Chrome, Edge or Brave, or set `BROWSER_PATH` to one. |
| MCP tools don't show up | Check `node --version` is 22 or newer, and run `npx -y claude-image-gen --version`. In Claude Code, `/mcp` lists servers and their errors. |
| Google says the browser "may not be secure" while you sign in | Update the browser, or sign in with another one: `claude-image-gen login --browser edge`. |
| Anything else | Run the command again with `CIG_DEBUG=1`. It saves `claude-image-gen-debug.png`, a screenshot of what Flow showed. Attach it to an [issue](https://github.com/pshen44/claude-image-gen/issues). |

<details>
<summary>Settings (environment variables)</summary>

| Variable | Default | What it does |
|---|---|---|
| `CIG_HOME` | `~/.claude-image-gen` | Where accounts and settings live |
| `CIG_TIMEOUT` | `240` images, `600` videos | Seconds to wait for one generation |
| `BROWSER_PATH` | auto | Use this browser executable |
| `CIG_DEBUG` | off | Save a screenshot when something fails |
| `CIG_OUTPUT_DIR` | see [MCP server](#mcp-server) | Where the MCP server saves files given no absolute path |

</details>

## FAQ

**Is it really free?** The tool is, and it needs no API key. In Flow, images cost no credits on every model today. Videos spend Flow credits, which refill daily; paid Google AI plans get more of them.

**Does it remove watermarks?** No. Files are saved exactly as Flow makes them, including Google's invisible SynthID watermark, which marks them as AI-generated.

**Can it use Firefox or Safari?** No. It talks to the browser through the Chrome DevTools Protocol, which only Chromium-based browsers speak (Chrome, Edge, Brave, Chromium, Arc, Vivaldi). For one that isn't auto-detected, set `BROWSER_PATH`.

**Why not Playwright or Puppeteer?** Either would add a large download and a dependency tree. This is one file of plain Node.js that drives the browser you already have.

**Does it work on a server with no screen?** Yes, once it's signed in. `login` needs a window one time (remote desktop works); every other command runs headless.

**What about reference images and image-to-video?** Not yet. That's next on the [roadmap](#roadmap). PRs welcome.

## How it works

Flow has no public API, so the tool drives Flow's website the way you would. It starts your browser headless with a private profile, opens a Flow project it made for itself, picks the model and settings in Flow's settings menu, types the prompt and presses Create. Then it waits for the new tile and downloads it through Flow's own **Download > Original size**, so you get the full-quality file, not the preview. It talks to the browser over the Chrome DevTools Protocol using Node's built-in `fetch` and `WebSocket`, and speaks MCP as plain JSON-RPC over stdio, so there are no dependencies.

```text
 Claude / any MCP client ──MCP (stdio)──┐
                                        ├─▶ claude-image-gen ──CDP──▶ headless Chrome ──▶ Flow ──▶ file on disk
 terminal / scripts ─────────CLI───────┘
```

Flow's page changes often. When it does, the tool stops with a clear message instead of saving the wrong thing: it checks the file type of every download and refuses anything that isn't the image or video it asked for.

## Roadmap

- Reference images and image-to-video
- More providers behind the same tools: official APIs (Gemini, OpenAI, fal, Replicate) next to Flow, so the tools keep
  working when Flow changes and can use a paid key when you have one
- A listing in the MCP Registry, and a Claude Desktop extension (`.mcpb`)

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Flow's website changes without notice, so the
most useful bug report is the command you ran, the error, and the `claude-image-gen-debug.png` that `CIG_DEBUG=1` saves.

The whole tool is [one file](claude-image-gen.js) with no dependencies. `npm test` runs unit tests, an MCP protocol test,
and browser tests that drive a real headless Chrome against a [fake Flow page](test/fixtures/flow.html), so a change to how
the tool reads Flow can be checked without a Google account.

## Disclaimer

An independent project, not affiliated with, endorsed by or supported by Google or Anthropic. It automates the Flow website with your own account, so you are responsible for following [Google's terms](https://policies.google.com/terms) and Flow's usage limits. Use it at your own risk.

## License

[MIT](LICENSE). Originally created by [jonjoncheese](https://github.com/jonjoncheese); maintained by [pshen44](https://github.com/pshen44).
