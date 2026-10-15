import { expect, type Page } from "@playwright/test";

/** Check compositing, not only DOM visibility or geometry: video can cover text. */
export async function expectBroadcastPainted(page: Page, text: string) {
  const card = page
    .locator(".live-broadcast")
    .filter({ hasText: text })
    .first();
  await expect(card).toBeVisible();
  await expect
    .poll(
      () =>
        card.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (
            Number(style.opacity) < 0.99 ||
            style.visibility !== "visible" ||
            !bounds.width ||
            !bounds.height
          )
            return false;
          // Broadcasts intentionally ignore pointer input. Temporarily enable hit
          // testing on this card to inspect the actual stacking order at its center.
          const node = element as HTMLElement;
          const previous = node.style.pointerEvents;
          node.style.pointerEvents = "auto";
          try {
            const painted = document.elementFromPoint(
              bounds.x + bounds.width / 2,
              bounds.y + bounds.height / 2,
            );
            return painted !== null && node.contains(painted);
          } finally {
            node.style.pointerEvents = previous;
          }
        }),
      {
        message:
          "broadcast must paint above the video, not merely exist behind it",
      },
    )
    .toBe(true);
}
