// Window visibility is controlled purely through the Chrome DevTools
// Protocol (Browser.setWindowBounds), not OS-level scripting: it targets our
// exact automated window (via the CDP session tied to our page), needs no
// macOS Accessibility permission, and can't be confused with the user's own
// Chrome windows, which also run under the "Google Chrome" process name.

async function setWindowState(context, page, windowState) {
  const session = await context.newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function hideWindow(context, page) {
  await setWindowState(context, page, 'minimized');
}

export async function showWindow(context, page) {
  await setWindowState(context, page, 'normal');
  await page.bringToFront().catch(() => {});
}
