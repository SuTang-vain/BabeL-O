// Compatibility facade. EverOS memory setup is runtime-owned; CLI command
// modules import this path while the implementation stays outside CLI.
export * from '../runtime/everosBootstrap.js'
