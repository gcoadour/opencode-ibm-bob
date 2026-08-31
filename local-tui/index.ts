// A dedicated directory pointing at ../src/tui.tsx, so a raw absolute path
// works in `plugin` the same way it does for the main entry point.
//
// `opencode-ibm-bob/tui` (the package's real subpath export) only resolves
// through proper package resolution — a plain `plugin: ["/path/to/repo/tui"]`
// entry does not, since that is filesystem path concatenation, not a module
// specifier lookup. This directory has its own package.json, so it resolves
// as a plugin root exactly like the repo's own directory does for the server
// half, with no linking or installing required. See README.md > "Sidebar
// Bobcoins widget" for the config to use it with.
export { default } from "../src/tui.tsx"
