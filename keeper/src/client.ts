// The single point where the keeper reaches into the shared client package (SPEC §10.1, §12).
//
// `@luckydraw/client` publishes itself through an exports map that points at `dist/`, which is gitignored and
// exists only after `pnpm --filter @luckydraw/client build`. The keeper runs its TypeScript sources directly
// under Node's type stripping, exactly as the client does, so it imports the client's *sources* by relative
// path: `tsc` and Node resolve a `.ts` relative specifier the same way, so `typecheck`, `test` and `start`
// all work with no `paths` alias, no `--import` loader and no built `dist`.
//
// Every other file in `keeper/src` imports from here, so this relative path is written once.

export * from "../../packages/client/src/index.ts";
