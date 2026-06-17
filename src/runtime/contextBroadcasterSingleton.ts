// src/runtime/contextBroadcasterSingleton.ts
//
// PR-A2: thin re-export of the module-level ContextBroadcaster singleton
// from src/nexus/contextBroadcaster.ts. Lives in src/runtime/ to avoid a
// circular import (app.ts → runtime/runtimePipeline.ts → nexus/...).
//
// Tests that need to override the broadcaster (e.g. to drive events
// directly into the WS) should import the real class from
// src/nexus/contextBroadcaster.ts and inject it via the app's
// contextBroadcaster option. The runtime hot path always uses the
// singleton, so swapping the singleton instance is a deliberate, scoped
// action for tests.

export {
  ContextBroadcaster,
  defaultContextBroadcaster,
  setDefaultContextBroadcaster,
  type ContextEvent,
  type ContextEventHandler,
} from '../nexus/contextBroadcaster.js'
