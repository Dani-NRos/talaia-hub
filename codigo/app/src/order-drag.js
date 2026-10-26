// Reordering the rows of a list by dragging their handle (mouse and finger), shared by the panels on the board and the
// readings of a panel. Rows are `.ord-row` with a `.ord-pos` number and up/down buttons (`[data-dir]`); the list says
// what changed through `onDrop(list)`. While a drag is under way nothing should repaint the list (`isDragging()`).
let dragging = 0;
export const isDragging = () => dragging > 0;

/** handle: selector of the grip; active(): whether the list is in ordering mode; onDrop(list): the <ol> after a drop. */
export function enableDrag({ handle, active, onDrop }) {
  let drag = null;
  const renumber = (list) => {
    [...list.children].forEach((row, i, all) => {
      row.querySelector(".ord-pos").textContent = String(i + 1);
      row.querySelector('[data-dir="-1"]').disabled = i === 0;
      row.querySelector('[data-dir="1"]').disabled = i === all.length - 1;
    });
  };
  document.addEventListener("pointerdown", (ev) => {
    const h = ev.target.closest?.(handle);
    if (!h || !active()) return;
    const row = h.closest(".ord-row");
    ev.preventDefault();
    h.setPointerCapture(ev.pointerId);
    drag = { row, list: row.parentElement, y0: ev.clientY };
    dragging++;
    row.classList.add("dragging");
  });
  document.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const { row, list } = drag;
    let dy = ev.clientY - drag.y0;
    // Past half of the neighbouring row, they swap places.
    const next = row.nextElementSibling, prev = row.previousElementSibling;
    if (dy > 0 && next && dy > next.offsetHeight / 2) { list.insertBefore(next, row); drag.y0 += next.offsetHeight; dy = ev.clientY - drag.y0; renumber(list); }
    else if (dy < 0 && prev && -dy > prev.offsetHeight / 2) { list.insertBefore(row, prev); drag.y0 -= prev.offsetHeight; dy = ev.clientY - drag.y0; renumber(list); }
    row.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (!drag) return;
    const { row, list } = drag;
    row.style.transform = "";
    row.classList.remove("dragging");
    drag = null;
    dragging--;
    onDrop(list);
  };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}
