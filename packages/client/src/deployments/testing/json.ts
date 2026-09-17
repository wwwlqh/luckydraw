// Path helpers for mutating a parsed JSON document in the deployment tests.
//
// Excluded from the published build by tsconfig.build.json ("src/**/testing/**"). Kept out of the test files
// themselves so both of them can mutate a manifest copy without an `any` anywhere.

export type JsonObject = {[key: string]: unknown};

function container(value: unknown, at: string): JsonObject {
  if (value === null || typeof value !== "object") {
    throw new Error(`not an object or array at ${at}: ${String(value)}`);
  }
  return value as JsonObject;
}

function walk(root: JsonObject, path: string): {parent: JsonObject; key: string} {
  const segments = path.split(".");
  let node: JsonObject = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] ?? "";
    node = container(node[segment], segments.slice(0, index + 1).join("."));
  }
  return {parent: node, key: segments[segments.length - 1] ?? ""};
}

/** Reads `assets.0.pool.seedAmount` style paths. */
export function getAt(root: JsonObject, path: string): unknown {
  const {parent, key} = walk(root, path);
  return parent[key];
}

export function setAt(root: JsonObject, path: string, value: unknown): void {
  const {parent, key} = walk(root, path);
  parent[key] = value;
}

export function deleteAt(root: JsonObject, path: string): void {
  const {parent, key} = walk(root, path);
  delete parent[key];
}

/** The array at `path`, for tests that need to iterate one. */
export function arrayAt(root: JsonObject, path: string): JsonObject[] {
  const value = getAt(root, path);
  if (!Array.isArray(value)) throw new Error(`not an array at ${path}`);
  return value as JsonObject[];
}
