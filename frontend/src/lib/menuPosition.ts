/**
 * Positions a fixed `.contextMenu` element at a viewport anchor, flipping
 * it above / to the left of the anchor when it would overflow and clamping
 * it inside the viewport with a 25px bottom and 10px side pad. Sets one of
 * `contextMenu__top` / `contextMenu__bottom` and one of `contextMenu__left`
 * / `contextMenu__right` so the stylesheet can point the caret. Retries on
 * the next frame while the menu has not been laid out yet (0×0).
 *
 * Shared by ChannelContextMenu and MessageActionMenu.
 */
export function positionMenu(menuEl: HTMLElement, x: number, y: number): void {
  const doPosition = () => {
    const height = menuEl.offsetHeight;
    const width = menuEl.offsetWidth;
    if (height === 0 || width === 0) {
      requestAnimationFrame(doPosition);
      return;
    }
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    const bottomPad = 25;
    const rightPad = 10;

    menuEl.classList.remove('contextMenu__top', 'contextMenu__bottom', 'contextMenu__left', 'contextMenu__right');

    // Clamp y to viewport and handle flipping with off-screen top
    let clampedY = y;
    if (clampedY < bottomPad) clampedY = bottomPad;
    if (clampedY + height + bottomPad > windowHeight) {
      if (y - height - bottomPad >= bottomPad) {
        menuEl.classList.add('contextMenu__bottom');
        menuEl.style.top = 'auto';
        menuEl.style.bottom = (windowHeight - y) + 'px';
        const flippedTop = y - height;
        if (flippedTop < bottomPad) {
          menuEl.style.bottom = 'auto';
          menuEl.style.top = bottomPad + 'px';
          menuEl.classList.remove('contextMenu__bottom');
          menuEl.classList.add('contextMenu__top');
        }
      } else {
        menuEl.classList.add('contextMenu__top');
        menuEl.style.top = Math.max(bottomPad, windowHeight - height - bottomPad) + 'px';
        menuEl.style.bottom = 'auto';
      }
    } else {
      menuEl.classList.add('contextMenu__top');
      menuEl.style.top = clampedY + 'px';
      menuEl.style.bottom = 'auto';
    }

    let clampedX = x;
    if (clampedX < rightPad) clampedX = rightPad;
    const rightOverflow = clampedX + width > windowWidth - rightPad;
    if (rightOverflow && clampedX >= width) {
      menuEl.classList.add('contextMenu__right');
      menuEl.style.left = 'auto';
      menuEl.style.right = (windowWidth - clampedX) + 'px';
    } else {
      const maxLeft = windowWidth - width - rightPad;
      const finalLeft = Math.max(rightPad, Math.min(clampedX, maxLeft));
      menuEl.classList.add('contextMenu__left');
      menuEl.style.left = finalLeft + 'px';
      menuEl.style.right = 'auto';
    }
  };
  doPosition();
}
