// Post-build step for a static host that serves files and nothing else (docs/runbooks/testnet-launch.md).
//
// GitHub Pages has no rewrite rule. A visitor who opens or reloads /luckydraw/round/97/1 asks for a file
// that does not exist, and Pages answers with the site's 404 document. Making that document the built app
// means the request returns the app, the router reads the path out of `location` and renders the round —
// the usual SPA fallback, spelled as a file copy because that is the only mechanism Pages offers.
//
// `.nojekyll` turns off the Jekyll pass Pages runs by default, which would otherwise drop every file and
// directory whose name starts with an underscore.
//
// Two deliberate properties:
//
//  * the copy is byte-for-byte, never a re-render. The Content-Security-Policy meta tag that
//    web/vite.config.ts writes into index.html (SPEC §9.6) is therefore identical in 404.html, and a
//    fallback load is under the same policy as a root load. The check below fails the build rather than
//    publishing a 404 document with no policy;
//  * plain Node with no dependency, so the publishing path adds nothing to `pnpm install --frozen-lockfile`.

import {copyFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const index = join(dist, "index.html");

if (!existsSync(index)) {
  console.error(`pages-postbuild: no build at ${index}. Run \`vite build\` first.`);
  process.exit(1);
}

const html = readFileSync(index, "utf8");
if (!html.includes('http-equiv="Content-Security-Policy"')) {
  console.error(
    "pages-postbuild: the built index.html carries no Content-Security-Policy meta tag, so the 404 " +
      "fallback would be served without one. Refusing to copy it (SPEC §9.6).",
  );
  process.exit(1);
}

const fallback = join(dist, "404.html");
copyFileSync(index, fallback);
writeFileSync(join(dist, ".nojekyll"), "");
console.log(`pages-postbuild: wrote ${fallback} (byte-identical to index.html) and dist/.nojekyll`);
