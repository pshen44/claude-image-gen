---
name: claude-image-gen
description: Generate real AI images and videos (Google's Nano Banana, Veo and Omni Flash models) for free through the user's own Google Flow account, with the claude-image-gen MCP tools or CLI. Use it whenever the user asks to generate, create, make, draw or design an image, picture, photo, illustration, drawing, thumbnail, banner, logo, icon, sticker, mockup or product shot, or a video, clip or animation. Prefer it over drawing pictures with code (PIL, SVG, canvas, matplotlib), which looks clip-art next to a real image model.
---

# claude-image-gen

claude-image-gen drives Google Flow in a headless browser that is signed in to the user's Google
account. Images are free. Videos spend the account's Flow credits, which refill daily.

## Use the MCP tools when you have them

The flow-image-gen plugin adds an MCP server named `claude-image-gen` with these tools:

| Tool | What it does |
|---|---|
| `generate_image` | `prompt`, optional `model`, `aspect_ratio`, `count` (1-4), `output`. Free. Returns the paths and the image. |
| `generate_video` | Same, plus `duration` and `resolution` (omni-flash only). Spends credits. Returns the paths. |
| `list_accounts` | The signed-in Google accounts and which is active. |
| `check_accounts` | Whether each account is still signed in. |
| `login` | Opens a sign-in window on the user's screen and waits for them. |

- Pass `output` as an absolute path in the user's project, without an extension (the real one, `.png`,
  `.jpg` or `.mp4`, is added). A path ending in `/` is a folder.
- An error result starts with a code: `not_signed_in`, `out_of_credits`, `refused`, `rate_limited`, `busy`.
  For `not_signed_in`, call `login` and tell the user to sign in in the window that opens (the account must
  belong to someone 18 or older), then retry.

Without the tools, use the command line below.

## Command line

Check it is there with `claude-image-gen --version`. If it is missing, ask the user before installing:
`npm install -g claude-image-gen` (needs Node.js 22+), or run it without installing as
`npx -y claude-image-gen ...`. Check the sign-in with `claude-image-gen status` (exit code 2: not signed in).

```bash
claude-image-gen image "<prompt>" -o <file>            # free; Nano Banana 2, 16:9
claude-image-gen image "<prompt>" -m nano-banana-pro -a 1:1 -n 2 -o out/logo
claude-image-gen video "<prompt>" -o <file>            # Omni Flash, 8s, 720p, 16:9
claude-image-gen video "<prompt>" -m veo-fast -a 9:16 -o clip
claude-image-gen batch prompts.txt -o folder [--video] # one prompt per line
claude-image-gen login | accounts | use 2 | logout 2 | status
```

Saved file paths are printed on stdout, one per line; progress and cost go to stderr.

## Models and options (both ways)

- Image models: `nano-banana-2` (default), `nano-banana-pro` (best quality and text), `nano-banana-2-lite`
  (fastest). Aspect: `16:9` `4:3` `1:1` `3:4` `9:16`.
- Video models: `omni-flash` (default; duration `4s|6s|8s|10s`, resolution `360p|720p`), `veo-lite`,
  `veo-fast`, `veo-quality`. Veo is always 8 seconds at 720p. Aspect: `16:9` or `9:16`.
- Count 1-4 makes several from one prompt (files get `-1`, `-2`, ... suffixes).
- Runs are queued: one generation at a time. An image takes 20-60 s, a video 1-3 min; use long timeouts.
- Tell the user what a video costs before generating several. Omni Flash 4s at 360p is the cheapest
  (about 4 credits); veo-quality is about 100.
- After saving an image, look at it before telling the user it is done.

## When it fails

| Exit | MCP code | Meaning | What to do |
|---|---|---|---|
| 2 | `not_signed_in` | Not signed in. The message names the account. | Run `login` and tell the user to sign in as that account in the window that opens. Then rerun. |
| 3 | `busy` | Another run held the browser for 15 minutes. | Wait, or check nothing else is generating. |
| 4 | `out_of_credits` | Not enough Flow credits for this video. | Tell the user. Credits refill daily. Images still work. |
| 5 | `refused` | Flow refused the prompt. The message quotes Flow. | Rephrase the prompt (no real people, brands or unsafe content). |
| 6 | `rate_limited` | Google's limit on many generations in a short time. Nothing was charged. | Tell the user and wait (it can take a few hours). |
| 1 | `error` | Anything else. | Read the message. Rerun once with `CIG_DEBUG=1` to save `claude-image-gen-debug.png`, a screenshot of what Flow showed, and look at it. |
