import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TypewriterText from "./typewriter-text";

describe("TypewriterText rendering", () => {
  it("makes the complete response accessible before the visual reveal finishes", () => {
    const markup = renderToStaticMarkup(
      <TypewriterText text="Complete agent response" animate />,
    );

    expect(markup).toContain('<span class="app-sr-only">Complete agent response</span>');
    expect(markup).toContain('<span class="typewriter-reveal is-typing" aria-hidden="true"></span>');
  });

  it("renders ordinary text without animation markup", () => {
    expect(
      renderToStaticMarkup(
        <TypewriterText text="Conversation history" animate={false} />,
      ),
    ).toBe("Conversation history");
  });
});
