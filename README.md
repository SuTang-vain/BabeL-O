# BabeL-O

BabeL-O is a Nexus-first rewrite of BabeL-X.

The project keeps the good parts of BabeL-X's programming workflow while moving execution into a service-oriented Nexus core:

- interactive CLI remains a first-class surface
- Nexus owns execution, sessions, tasks, tools, and permissions
- CLI owns interaction and calls Nexus APIs
- provider/model support is adapter-based
- storage is isolated behind a small interface

## Quick Start

```bash
npm install
npm run typecheck
npm test
npm run cli -- run "hello"
npm run cli -- chat
npm link
bbl run "hello"
bbl chat
npm run start
```

## Current Scope

This is the first clean rewrite slice. It includes:

- Fastify Nexus API
- WebSocket streaming
- Commander CLI
- in-memory storage
- session/task/event model
- runtime facade
- basic local coding tools
- interactive chat loop

Model-provider adapters are intentionally stubbed behind clean interfaces so they can be added without contaminating Nexus core.
