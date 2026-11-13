/** Hash routes, because GitHub Pages serves the same index.html for every address. */
import { createStore, useStore } from "./stores";

export type Route =
  | { page: "home" }
  | { page: "thread"; id: string }
  | { page: "view"; id: string }
  | { page: "judge"; id: string }
  | { page: "share"; id: string };

const PREFIXES = { t: "thread", v: "view", j: "judge", s: "share" } as const;

function parse(hash: string): Route {
  const [, prefix, id] = hash.replace(/^#/, "").split("/");
  const page = PREFIXES[prefix as keyof typeof PREFIXES];
  return page && id ? { page, id } : { page: "home" };
}

export function hrefFor(route: Route): string {
  if (route.page === "home") return "#/";
  const prefix = Object.entries(PREFIXES).find(([, page]) => page === route.page)![0];
  return `#/${prefix}/${route.id}`;
}

const routeStore = createStore<Route>(parse(location.hash));
window.addEventListener("hashchange", () => routeStore.set(parse(location.hash)));

export function navigate(route: Route) {
  location.hash = hrefFor(route);
}

export const useRoute = () => useStore(routeStore);
export const currentRoute = () => routeStore.get();

export function shareUrl(shareId: string): string {
  return `${location.origin}${location.pathname}${hrefFor({ page: "share", id: shareId })}`;
}
