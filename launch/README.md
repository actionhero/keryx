# Product Hunt launch — Keryx

Working folder for the Keryx PH launch. Lives in git so the copy can be reviewed and revised before launch day.

## What's here

| File | Purpose |
|---|---|
| `tagline.md` | The shortlist of taglines (60-char cap). Pick one before submitting. |
| `description.md` | The PH description (256 chars). Final, ready to paste. |
| `maker-comment.md` | First comment from the maker. Posts as soon as the listing goes live. |
| `topics.md` | The 4 PH topics to pick when submitting. |
| `gallery-spec.md` | What each of the 5 gallery slots is, current state, and what's still needed. |
| `runbook.md` | Pre-launch timeline, launch-morning playbook, comment-response templates, cross-post copy. |

## Gallery assets

| Slot | Status | Files |
|---|---|---|
| 1 — Thumbnail (one action, every transport) | Done | `producthunt-thumbnail.svg` + `.png` |
| 2 — Quickstart (terminal) | Done | `producthunt-slot2-quickstart.svg` + `.png` |
| 3 — Claude Desktop calling MCP | Done | `producthunt-slot3-claude.svg` + `.png` (sources real screenshot `screenshot-claude-desktop.png`) |
| 4 — Typed frontend | Open | needs editor screenshot |
| 5 — Demo gif | Optional | needs short loom or gif |

## Regenerating PNGs

```bash
cd launch
rsvg-convert -w 1270 producthunt-thumbnail.svg -o producthunt-thumbnail.png
rsvg-convert -w 1270 producthunt-slot2-quickstart.svg -o producthunt-slot2-quickstart.png
rsvg-convert -w 1270 producthunt-slot3-claude.svg -o producthunt-slot3-claude.png
```

Requires `librsvg` (`brew install librsvg`).
