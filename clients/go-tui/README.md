# BabeL-O Go TUI MVP

This is a minimal external TUI MVP for BabeL-O Nexus.

It intentionally does not replace `bbl chat` and does not embed the TypeScript
runtime. The client connects to an already running Nexus service via the public
WebSocket stream API and renders a Bubble Tea shell with a transcript, status
header, input line, permission panel and layered event output.

## Scope

- Connect to `GET /v1/stream`.
- Submit one prompt from the bottom input line.
- Render assistant, thinking, tool, permission, usage, result and error events
  with stable labels.
- Merge streaming assistant/thinking deltas into the current transcript line.
- Handle `permission_request` with approve/reject keyboard actions and a visible
  permission panel.
- Keep all provider, context, tool, permission and session ownership in Nexus.

## Run

Start Nexus in another terminal:

```bash
cd /Users/tangyaoyue/DEV/BABEL/BabeL-O
NEXUS_ALLOWED_TOOLS='*' npm run start
```

Then run the MVP through the BabeL-O CLI:

```bash
cd /Users/tangyaoyue/DEV/BABEL/BabeL-O
npm run cli -- go --url http://127.0.0.1:3000 --cwd /Users/tangyaoyue/DEV/BABEL/BabeL-O
```

The `bbl go` entry prefers a prebuilt `clients/go-tui/go-tui` binary when it is
present and falls back to `go run .` from this directory.

You can also run the client directly:

```bash
cd /Users/tangyaoyue/DEV/BABEL/BabeL-O/clients/go-tui
go run . --url http://127.0.0.1:3000 --cwd /Users/tangyaoyue/DEV/BABEL/BabeL-O
```

Keys:

- `enter`: submit the current input.
- `ctrl+c`: quit.
- `q`: quit when idle and the input is empty.
- `a` / `y`: approve a pending permission request.
- `r` / `n`: reject a pending permission request.
