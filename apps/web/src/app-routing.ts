export type AppSurface = "landing" | "product";

export type ProductRoute =
  | "onboarding"
  | "projects"
  | "add-project"
  | "connections"
  | "settings"
  | "workspace";

export type ProductLocation = {
  route: ProductRoute;
  projectId: string | null;
};

export const APP_PATH = "/app";
export const ONBOARDING_PATH = "/app/onboarding";

export function surfaceFromUrl(pathname: string, search: string): AppSurface {
  if (pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`)) {
    return "product";
  }
  return new URLSearchParams(search).get("view") === "platform"
    ? "product"
    : "landing";
}

export function canonicalProductUrl(
  pathname: string,
  search: string,
): string | null {
  if (pathname === APP_PATH || pathname.startsWith(`${APP_PATH}/`)) {
    return null;
  }
  const parameters = new URLSearchParams(search);
  if (parameters.get("view") !== "platform") return null;
  parameters.delete("view");
  const nextSearch = parameters.toString();
  return `${APP_PATH}${nextSearch ? `?${nextSearch}` : ""}`;
}

export function productLocationFromUrl(
  pathname: string,
  search: string,
  preview: boolean,
): ProductLocation {
  if (pathname === ONBOARDING_PATH) {
    return { route: "onboarding", projectId: null };
  }
  if (pathname === `${APP_PATH}/connections`) {
    return { route: "connections", projectId: null };
  }
  if (pathname === `${APP_PATH}/settings`) {
    return { route: "settings", projectId: null };
  }
  if (pathname === `${APP_PATH}/projects/new`) {
    return { route: "add-project", projectId: null };
  }
  const projectMatch = pathname.match(/^\/app\/projects\/([^/]+)\/?$/);
  if (projectMatch?.[1]) {
    try {
      return {
        route: "workspace",
        projectId: decodeURIComponent(projectMatch[1]),
      };
    } catch {
      return { route: "projects", projectId: null };
    }
  }
  // Preserve the old local-preview link while callers move to
  // /app/onboarding?preview=1.
  if (
    preview &&
    new URLSearchParams(search).get("route") === "onboarding"
  ) {
    return { route: "onboarding", projectId: null };
  }
  return { route: "projects", projectId: null };
}

export function productPath(
  route: ProductRoute,
  projectId: string | null = null,
  preview = false,
): string {
  const pathname =
    route === "onboarding"
      ? ONBOARDING_PATH
      : route === "add-project"
        ? `${APP_PATH}/projects/new`
      : route === "connections"
        ? `${APP_PATH}/connections`
        : route === "settings"
          ? `${APP_PATH}/settings`
          : route === "workspace" && projectId
            ? `${APP_PATH}/projects/${encodeURIComponent(projectId)}`
            : APP_PATH;
  return `${pathname}${preview ? "?preview=1" : ""}`;
}
