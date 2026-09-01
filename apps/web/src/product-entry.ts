export type ProductEntryRoute = "onboarding" | "projects";

export function initialProductEntryRoute({
  authenticated,
  preview,
  requestedPreviewRoute,
}: {
  authenticated: boolean;
  preview: boolean;
  requestedPreviewRoute: string | null;
}): ProductEntryRoute {
  if (preview) {
    return requestedPreviewRoute === "onboarding" ? "onboarding" : "projects";
  }
  return authenticated ? "projects" : "onboarding";
}

export function productEntryRouteAfterDiscovery(
  projectCount: number,
): ProductEntryRoute {
  return projectCount > 0 ? "projects" : "onboarding";
}
