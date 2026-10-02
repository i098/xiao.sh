// /app.js — the DOM-rendered app: the same tui/*.tsx tree bundled for the browser.
// The plugin re-targets three seams for modules under tui/: the JSX runtime (intrinsic
// box/text/... tags → DOM primitives), the @opentui packages (→ browser shims), and the
// @/lib data modules (→ fetch-based twins; non-twin libs resolve to the real src/lib —
// which also covers Bun.build's tsconfig-paths gap).
// Used per request by the Bun server and once at deploy time for the Cloudflare Worker
// (`bun server/bundle.ts` writes dist/, which wrangler.jsonc serves as static assets).
const APP_TWINS = new Set(["spotify", "preview", "ai", "sessions", "presence", "github", "analytics", "questions"]);

export async function buildAppJs(dev: boolean): Promise<string> {
  const dom = new URL("../web/dom/", import.meta.url).pathname;
  const lib = new URL("../src/lib/", import.meta.url).pathname;
  const result = await Bun.build({
    entrypoints: [new URL("../web/main.ts", import.meta.url).pathname],
    target: "browser",
    minify: !dev,
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    plugins: [
      {
        name: "dom-target",
        setup(b) {
          b.onResolve({ filter: /^react\/jsx(-dev)?-runtime$/ }, (a) =>
            a.importer.includes("/tui/") ? { path: `${dom}jsx-runtime.ts` } : undefined,
          );
          b.onResolve({ filter: /^@opentui\/react$/ }, () => ({ path: `${dom}hooks.ts` }));
          b.onResolve({ filter: /^@opentui\/core$/ }, () => ({ path: `${dom}opentui-core.ts` }));
          b.onResolve({ filter: /^@\/lib\/(.+)$/ }, (a) => {
            const m = a.path.slice("@/lib/".length);
            return { path: APP_TWINS.has(m) ? `${dom}libs/${m}.ts` : `${lib}${m}.ts` };
          });
        },
      },
    ],
  });
  return result.outputs[0].text();
}

if (import.meta.main) {
  await Bun.write("dist/app.js", await buildAppJs(false));
  // the cat (public/favicon.ico is the untouched create-next-app icon) under both names
  await Bun.write("dist/favicon.png", Bun.file("public/favicon.png"));
  await Bun.write("dist/favicon.ico", Bun.file("public/favicon.png"));
  console.log("wrote dist/app.js, dist/favicon.png, dist/favicon.ico");
}
