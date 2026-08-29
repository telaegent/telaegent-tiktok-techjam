import { useEffect, useState } from "react";
import { BRAND, DEMO_URL, NAV_LINKS } from "../data/content";

export function Nav() {
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="nav" data-stuck={stuck}>
      <div className="shell nav-inner">
        <a className="brand" href="#top" aria-label={`${BRAND} — home`}>
          <img src="/telaegent-wordmark.png" alt={BRAND} />
        </a>

        <nav className="nav-links" aria-label="Sections">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="nav-actions">
          <a className="btn btn-ghost btn-sm" href="#flow">
            The flow
          </a>
          <a className="btn btn-primary btn-sm" href={DEMO_URL}>
            Launch demo
          </a>
        </div>
      </div>
    </header>
  );
}
