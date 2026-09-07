import type { RuntimeModelCatalogue } from "./api";

/** Setup is performed by the owning human in the local terminal. */
export function ProviderSetup({ catalogue, availabilityKnown, onRefresh }: {
  catalogue: RuntimeModelCatalogue | null;
  availabilityKnown: boolean;
  onRefresh: () => void;
}) {
  return (
    <details className="provider-setup">
      <summary>Manage coding agents</summary>
      <div className="provider-setup-content">
        <ul aria-label="Coding agents for this repository">
          {(["claude", "codex"] as const).map((provider) => (
            <li key={provider}>
              <strong>{provider === "claude" ? "Claude Code" : "Codex"}</strong>
              <span>{!availabilityKnown ? "Availability unknown" :
                catalogue?.providers.some((item) => item.provider === provider)
                  ? "Connected locally" : "Not connected through your connector"}</span>
            </li>
          ))}
        </ul>
        <p>To add Claude, Codex, or both for this repository:</p>
        <ol>
          <li>Install and sign in to the coding CLI on your computer.</li>
          <li>Finish or cancel active agent work, then press Ctrl+C in the running Telaegent terminal.</li>
          <li>From the same repository root, run <code>tlg connect --provider choose</code> and select Claude, Codex, or Both providers.</li>
        </ol>
        <p>Keep that terminal running. If a CLI is unavailable, the terminal shows its setup status and lets you check again. Older connectors may need an update.</p>
        <p>Existing private drafts keep their original provider. Choose a connected provider for new drafts. Approved conversation history stays in Telaegent.</p>
        <p>Use Ctrl+C for this restart. <code>tlg disconnect</code> revokes the repository connection and its active grants.</p>
        <button className="app-secondary-action" type="button" onClick={onRefresh}>Check connection again</button>
      </div>
    </details>
  );
}
