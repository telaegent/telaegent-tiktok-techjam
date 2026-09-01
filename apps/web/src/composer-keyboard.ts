export type ComposerKeyEvent = Readonly<{
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}>;

export function shouldSubmitComposerOnKeyDown(event: ComposerKeyEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
