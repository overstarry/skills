---
name: image-to-eagle
description: Use this skill immediately after generating or editing any image with an image generation model, including when the image comes back only as a chat attachment with no file path. It archives the image into Eagle through the bundled Node script (never direct MCP tool calls) and preserves the exact prompt in Eagle annotation metadata. Trigger after alma image generate/edit, image-gen workflows, generated art, logos, avatars, illustrations, wallpapers, product shots, posters, icons, UI mockups, and batch image outputs. Use it even when the user did not explicitly ask to save the image, unless they explicitly say not to archive.
allowed-tools:
  - Bash
  - Read
---

# Image to Eagle

Archive generated images into Eagle and keep the exact generation prompt searchable.

All Eagle access goes through the bundled script. Never call `eagle__*` MCP tools from the
model: they can hang the turn. The script talks to Eagle's local API first (fast, no plugin
dependency) and falls back to the official Eagle Skill CLI, both under a hard timeout.

Script path (canonical location; every agent's skills directory links here):

```text
~/.agents/skills/image-to-eagle/scripts/archive-generated-image-to-eagle.js
```

## When to use

Required follow-up whenever an image is created or edited by a generation model:
`alma image generate/edit`, image-gen workflows returning local paths, generated logos,
avatars, illustrations, wallpapers, UI mockups, product shots, posters, icons, concept art,
and batch outputs.

Skip only when the user explicitly says not to save/archive/import to Eagle.
For selfies, run the selfie workflow first, then archive the final image.

## Quick start

The image usually arrives one of two ways. Pick the matching form.

**A — the image came back as a chat attachment** (no file path was printed, which is what
happens with Alma's built-in image generation): archive the newest file in the gallery
cache with `--latest`.

```bash
node ~/.agents/skills/image-to-eagle/scripts/archive-generated-image-to-eagle.js \
  --latest \
  --prompt "exact prompt used for generation"
```

**B — a command printed a local path** (`alma image generate`, `alma selfie take`, any
image-gen workflow returning a path):

```bash
node ~/.agents/skills/image-to-eagle/scripts/archive-generated-image-to-eagle.js \
  --path "/absolute/path/to/generated-image.png" \
  --prompt "exact prompt used for generation" \
  --model "model-name-if-known" \
  --aspect "16:9"
```

If the turn that generated the image ran no commands at all, archive on the **next** turn —
the image is still the newest file in the gallery cache, so `--latest` still finds it.
`--latest-count N` takes the newest N when one turn produced several.

One JSON object comes back with the item ID and the folder path. Report those in one line.

Long prompts: write the prompt to a file and pass `--prompt-file`, or pipe it with
`--prompt-stdin`. Never retype or summarize a prompt to fit shell quoting.

Multiple images from one generation: repeat `--path` (or point `--path` at the output
directory). Each item gets its own name suffix and the shared prompt.

Edits: add `--action edit --source-images "/path/to/input.png"`.

Remote-only images: `--url https://…` instead of `--path`.

## Options

| Option | Purpose |
| --- | --- |
| `--latest` / `--latest-count N` | Newest generated image(s) in the Alma gallery cache. |
| `--path PATH` | Local file or directory. Repeatable. |
| `--url URL` | Remote image. Repeatable. |
| `--image-dir DIR` | Search DIR instead of the gallery cache. |
| `--prompt` / `--prompt-file` / `--prompt-stdin` | The exact prompt. Required. |
| `--model`, `--action generate\|edit`, `--aspect`, `--source-images` | Generation metadata. |
| `--name NAME` | Item name. Defaults to a prompt slug plus the date. |
| `--tag TAG` / `--tags a,b` | Add one tag / replace the default tag set. |
| `--root-folder NAME`, `--root-folder-id ID`, `--folder-id ID` | Destination overrides. |
| `--no-date-subfolders` | Import into the root folder itself. |
| `--date YYYY-MM-DD` | Override the date subfolder. |
| `--skip-duplicate` | Skip images already archived in the destination folder. |
| `--dry-run` | Resolve folders and print the payload without writing. |
| `--check-connection` | Report Eagle reachability, then exit. |
| `--transport auto\|native\|mcp` | Default `auto`: local API first, Eagle Skill CLI fallback. |

Full option help: `node …/archive-generated-image-to-eagle.js --help`.

## Defaults

- Root folder `AI 生成图`, with a local-date subfolder, e.g. `AI 生成图/2026-08-27`
- Tags `AI生成`, `Prompt`, `Generated Image`
- Prompt stored in the Eagle item `annotation`
- Folders are matched by exact name **and** exact parent ID; a missing folder is created
  under a lock, and duplicate same-name folders resolve to the oldest one
- If the user names a target folder, pass it as `--root-folder`; a folder ID goes to
  `--folder-id` (which also disables the date subfolder)

## Annotation format

```text
Prompt:
<exact prompt used for generation or edit>

Generation:
- model: <model name, else unknown>
- action: <generate|edit>
- aspect_ratio: <ratio, else unspecified>
- source_images: <reference/input paths, else none>

Archive:
- source: AI image generation
- original_path: <local path or URL>
- archived_at: <local ISO datetime>
```

Do not summarize the prompt. Verbatim text is what makes the archive searchable and
reproducible. Keep language, style terms, negative instructions, aspect-ratio wording, and
reference-image notes exactly as sent to the model.

## Workflow

1. Generate or edit the image.
2. Capture the exact final prompt.
3. Locate the file: use the path the command printed, or `--latest` when the image only
   came back as an attachment.
4. Run the script once, covering every image from that generation.
5. Report the Eagle item ID(s) and the destination folder path. Keep it short.

Alma's generated images live in
`~/Library/Application Support/alma/gallery_cache/` (override with `ALMA_GALLERY_DIR`).
Files there named `upload-*` are the user's own uploads and are never archived by
`--latest`. The script warns when the newest file is over an hour old, which usually means
it is not the image just generated — check before reporting success.

## Troubleshooting

- Check reachability first when anything looks wrong:
  `node …/archive-generated-image-to-eagle.js --check-connection`
- `"Eagle API unreachable"` — Eagle is not running. Tell the user, keep the image path in
  the reply so it can be archived later, and do not retry in a loop.
- Native path fails but MCP works (or the reverse): the script already falls back and lists
  the reason under `warnings`. Force one side with `--transport native` or `--transport mcp`.
- Everything times out: Eagle is busy indexing. Retry once with `--timeout 30000`.
- Uncertain about prompt, folder, or which files to import: `--dry-run` first.
- `"No generated image found"` with `--latest`: the image never hit the gallery cache. Ask
  for the path, or pass `--image-dir`.

## Safety

- Never delete, move, or overwrite the generated source files after import.
- Never put API keys, provider tokens, or hidden system prompts into an annotation.
- Do not call `eagle__item_add`, `eagle__folder_get`, or `eagle__folder_create` directly.

Eagle API details and raw CLI recipes: [references/eagle-api.md](references/eagle-api.md).
