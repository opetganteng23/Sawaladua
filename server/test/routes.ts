import type { Express } from "express";

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: { source: string; fast_slash?: boolean };
}

const prefixOf = (re?: Layer["regexp"]): string => {
  if (!re || re.fast_slash) return "";
  const m = /^\^\\\/((?:[^\\?()|$^]|\\\/)+?)\\\/\?\(\?=\\\/\|\$\)/.exec(re.source);
  return m ? "/" + m[1]!.replace(/\\\//g, "/") : "";
};

/** Kumpulkan seluruh rute Express (method + path ber-prefix) untuk uji kesesuaian dengan OpenAPI. */
export function collectRoutes(app: Express): string[] {
  const out = new Set<string>();
  const walk = (stack: Layer[], prefix: string) => {
    for (const l of stack) {
      if (l.route) {
        for (const m of Object.keys(l.route.methods)) out.add(`${m.toUpperCase()} ${prefix}${l.route.path}`.replace(/:(\w+)/g, "{$1}"));
      } else if (l.name === "router" && l.handle?.stack) {
        walk(l.handle.stack, prefix + prefixOf(l.regexp));
      }
    }
  };
  walk((app as unknown as { _router: { stack: Layer[] } })._router.stack, "");
  return [...out].sort();
}
