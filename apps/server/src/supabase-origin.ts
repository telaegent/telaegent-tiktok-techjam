const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isSafeSupabaseOrigin(url: URL): boolean {
  const secureTransport = url.protocol === "https:";
  const localDevelopmentTransport =
    url.protocol === "http:" && loopbackHosts.has(url.hostname);
  return (
    (secureTransport || localDevelopmentTransport) &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0 &&
    (url.pathname === "/" || url.pathname === "")
  );
}
