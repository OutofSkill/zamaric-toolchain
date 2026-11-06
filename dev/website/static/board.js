import { confirmDialog, errorMessage, formatRelative, h, icon, prefersReducedMotion, renderMarkdown, request, SessionExpired } from "./app.js";
import Sortable from "./vendor/sortable.esm.js";

const columnTitleMaximum = 200;
const cardTitleMaximum = 200;
const cardBodyMaximum = 20000;
const columnMinimumWidth = 280;
const columnMaximumWidth = 480;
const addColumnWidth = 56;
const cardColors = [
  { value: "default", label: "Standard" },
  { value: "red", label: "Rot" },
  { value: "orange", label: "Orange" },
  { value: "yellow", label: "Gelb" },
  { value: "green", label: "Grün" },
  { value: "blue", label: "Blau" },
  { value: "purple", label: "Lila" },
];
const cardColorValues = new Set(cardColors.map((color) => color.value));

function cardColor(card) {
  return cardColorValues.has(card?.color) ? card.color : "default";
}

let board = null;
let sortables = [];
let columnsElement = null;
let addColumnElement = null;
let scroller = null;
let statusElement = null;
let openMenu = null;
let signal = null;
let creatingColumn = false;
let lastDragEnd = 0;
const clickAfterDragMs = 300;

export async function renderBoard(container, options = {}) {
  signal = options.signal ?? null;
  board = null;
  creatingColumn = false;
  statusElement = h("p", { class: "board-status", role: "status", "aria-live": "polite" });
  columnsElement = h("div", { class: "board-columns" });
  // „+ Spalte“ steht wie „+ Karte“ als leerer Zettel rechts neben der letzten Spalte
  addColumnElement = h(
    "button",
    { class: "add-column", type: "button", "data-focus-key": "new-column", "aria-label": "Spalte anlegen", hidden: true, onclick: startNewColumn },
    icon("plus", 18),
    h("span", { "aria-hidden": "true" }, "Spalte"),
  );
  scroller = h(
    "div",
    { class: "board", role: "region", "aria-label": "Spalten", tabindex: "0" },
    h("div", { class: "board-row" }, columnsElement, addColumnElement),
  );
  container.replaceChildren(
    h(
      "section",
      { class: "page page-board" },
      h("h1", { class: "visually-hidden" }, "Board"),
      h("div", { class: "board-surface" }, scroller, statusElement),
    ),
  );
  const resizeObserver = new ResizeObserver(() => fitColumns());
  resizeObserver.observe(scroller);
  signal?.addEventListener("abort", () => {
    resizeObserver.disconnect();
    destroySortables();
    closeMenu();
  });
  document.addEventListener("pointerdown", onOutsidePointer, { signal });
  document.addEventListener("keydown", onDocumentKey, { signal });
  await load();
}

async function load() {
  // Beim Neuladen bleiben die alten Spalten stehen, bis die neuen da sind
  if (!board) columnsElement.replaceChildren(h("p", { class: "loading" }, "Lädt …"));
  const data = await request("/api/board", { signal });
  if (signal?.aborted) return;
  board = { columns: Array.isArray(data?.columns) ? data.columns : [] };
  if (statusElement?.classList.contains("board-status-error")) {
    statusElement.classList.remove("board-status-error");
    statusElement.replaceChildren();
  }
  draw();
}

async function reload(failureMessage, cause) {
  try {
    await load();
    if (failureMessage) notify(`${failureMessage} ${errorMessage(cause)}`);
  } catch (error) {
    if (error instanceof SessionExpired || signal?.aborted) return;
    // Board evtl. nicht aktuell: Fehler bleibt stehen, bis neu geladen ist
    notify(`${failureMessage ?? "Laden fehlgeschlagen."} ${errorMessage(error?.code)}`, { retry: true });
  }
}

function notify(message, { retry = false } = {}) {
  if (!statusElement) return;
  clearTimeout(notify.timer);
  statusElement.classList.toggle("board-status-error", retry);
  if (!retry) {
    statusElement.replaceChildren(message);
    notify.timer = setTimeout(() => {
      if (statusElement) statusElement.replaceChildren();
    }, 6000);
    return;
  }
  statusElement.replaceChildren(
    message,
    " ",
    h("button", { class: "button small", type: "button", onclick: () => reload() }, "Erneut versuchen"),
  );
}

async function attempt(action, failureMessage) {
  try {
    await action();
    return true;
  } catch (error) {
    if (error instanceof SessionExpired || signal?.aborted) return false;
    await reload(failureMessage, error?.code);
    return false;
  }
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function findColumn(columnId) {
  return board.columns.find((column) => column.id === columnId);
}

function destroySortables() {
  for (const sortable of sortables) sortable.destroy();
  sortables = [];
}

function draw({ focus } = {}) {
  if (!board || signal?.aborted) return;
  closeMenu();
  destroySortables();

  // Ohne Spalten steht nur der Zettel „+ Spalte“ da, dann so breit wie eine Spalte
  const empty = !board.columns.length && !creatingColumn;
  columnsElement.hidden = empty;
  addColumnElement.hidden = creatingColumn;
  addColumnElement.querySelector("span").textContent = empty ? "Spalte anlegen" : "Spalte";
  if (empty) {
    columnsElement.replaceChildren();
    fitColumns();
    if (focus) focusElement(focus);
    return;
  }

  columnsElement.replaceChildren(...board.columns.map(columnElement), ...(creatingColumn ? [newColumnElement()] : []));
  fitColumns();
  const animation = prefersReducedMotion() ? 0 : 160;

  sortables.push(
    Sortable.create(columnsElement, {
      draggable: ".column",
      handle: ".column-handle",
      animation,
      delay: 120,
      delayOnTouchOnly: true,
      ghostClass: "is-ghost",
      chosenClass: "is-chosen",
      dragClass: "is-dragging",
      onEnd: (event) => {
        if (event.oldDraggableIndex === event.newDraggableIndex) return;
        const [column] = board.columns.splice(event.oldDraggableIndex, 1);
        board.columns.splice(event.newDraggableIndex, 0, column);
        lastDragEnd = Date.now();
        setTimeout(() => draw(), 0);
        void moveColumnOnServer(column.id, event.newDraggableIndex);
      },
    }),
  );

  for (const list of columnsElement.querySelectorAll(".card-list")) {
    sortables.push(
      Sortable.create(list, {
        group: "cards",
        draggable: ".board-card",
        // Leere Listen füllen die Spalte unter „+ Karte“; so landen Karten auch auf Kopf und „+ Karte“
        emptyInsertThreshold: 96,
        animation,
        delay: 120,
        delayOnTouchOnly: true,
        ghostClass: "is-ghost",
        chosenClass: "is-chosen",
        dragClass: "is-dragging",
        onEnd: (event) => {
          const fromColumn = findColumn(Number(event.from.dataset.columnId));
          const toColumn = findColumn(Number(event.to.dataset.columnId));
          if (!fromColumn || !toColumn) return;
          if (fromColumn === toColumn && event.oldDraggableIndex === event.newDraggableIndex) return;
          const [card] = fromColumn.cards.splice(event.oldDraggableIndex, 1);
          toColumn.cards.splice(event.newDraggableIndex, 0, card);
          lastDragEnd = Date.now();
          setTimeout(() => draw(), 0);
          void moveCardOnServer(card.id, toColumn.id, event.newDraggableIndex);
        },
      }),
    );
  }

  for (const body of columnsElement.querySelectorAll(".board-card-body")) {
    if (body.scrollHeight > body.clientHeight + 1) body.classList.add("is-clipped");
  }
  if (focus) focusElement(focus);
}

// „+ Spalte“ liegt neben der Spaltenliste, nicht in ihr
function focusElement(selector) {
  (columnsElement.querySelector(selector) ?? columnsElement.closest(".page")?.querySelector(selector))?.focus();
}

function columnElement(column, index) {
  const count = column.cards.length;
  const titleId = `column-title-${column.id}`;
  return h(
    "section",
    { class: "column", "data-column-id": String(column.id), "aria-labelledby": titleId },
    h(
      "header",
      { class: "column-head" },
      h("h2", { class: "column-title", id: titleId }, column.title),
      h(
        "span",
        { class: "column-count mono" },
        h("span", { "aria-hidden": "true" }, String(count)),
        h("span", { class: "visually-hidden" }, plural(count, "Karte", "Karten")),
      ),
      h(
        "button",
        // Nur für die Maus: per Tastatur verschiebt das Menü (nach links/rechts)
        { class: "icon-button column-handle", type: "button", tabindex: "-1", "aria-label": `Spalte „${column.title}“ verschieben (ziehen)`, title: "Ziehen zum Verschieben" },
        icon("grip", 16),
      ),
      h(
        "button",
        {
          class: "icon-button column-menu-button",
          type: "button",
          "aria-label": `Aktionen für Spalte „${column.title}“`,
          "aria-haspopup": "menu",
          "aria-expanded": "false",
          "data-focus-key": `menu-${column.id}`,
          onclick: (event) => toggleMenu(event.currentTarget, column, index),
        },
        icon("more", 18),
      ),
    ),
    h(
      "div",
      { class: "card-list", "data-column-id": String(column.id) },
      column.cards.map((card) => cardElement(card, column)),
    ),
    h(
      "button",
      {
        class: "add-card",
        type: "button",
        "data-focus-key": `add-${column.id}`,
        "aria-label": `Karte in „${column.title}“ hinzufügen`,
        onclick: () => openCardEditor(null, column),
      },
      icon("plus", 16),
      "Karte",
    ),
  );
}

function cardElement(card, column) {
  const titleId = `card-title-${card.id}`;
  const hasTitle = card.title.trim() !== "";
  const open = () => openCardEditor(card, column);
  return h(
    "article",
    {
      class: "board-card",
      "data-color": cardColor(card),
      tabindex: "0",
      "data-card-id": String(card.id),
      "data-focus-key": `card-${card.id}`,
      "aria-labelledby": hasTitle ? titleId : null,
      "aria-keyshortcuts": "Enter",
      onclick: (event) => {
        if (event.target.closest("a") || Date.now() - lastDragEnd < clickAfterDragMs) return;
        open();
      },
      onkeydown: (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      },
    },
    hasTitle ? h("h3", { class: "board-card-title", id: titleId }, card.title) : null,
    card.body.trim() ? h("div", { class: "board-card-body markdown" }, renderMarkdown(card.body)) : null,
    h("p", { class: "board-card-meta muted" }, h("time", { datetime: card.updated_at ?? "" }, card.updated_at ? formatRelative(card.updated_at) : "")),
  );
}

// Spalten so breit, dass im Ruhezustand nur ganze Spalten zu sehen sind. Weniger
// Spalten als Platz werden breiter, höchstens columnMaximumWidth.
// Passen alle Spalten, bleibt rechts Platz für den schmalen Zettel „+ Spalte“.
// Passen sie nicht, scrollt das Board; „+ Spalte“ steht am Ende und ist dann so
// breit wie eine Spalte, damit auch am Ende des Scrollens keine Spalte angeschnitten ist.
function fitColumns() {
  if (!scroller || !columnsElement) return;
  const scrollerStyle = getComputedStyle(scroller);
  const available = scroller.clientWidth - parseFloat(scrollerStyle.paddingLeft) - parseFloat(scrollerStyle.paddingRight);
  if (available <= 0) return;
  const gap = parseFloat(getComputedStyle(columnsElement).columnGap) || 0;
  const wanted = Math.max(1, (board?.columns.length ?? 0) + (creatingColumn ? 1 : 0));
  const showsAddColumn = !creatingColumn;
  const room = showsAddColumn ? available - addColumnWidth - gap : available;
  const fittingWithAdd = Math.max(1, Math.floor((room + gap) / (columnMinimumWidth + gap)));
  let width;
  let addWidth = addColumnWidth;
  if (wanted <= fittingWithAdd) {
    width = Math.min(columnMaximumWidth, (room - (wanted - 1) * gap) / wanted);
  } else {
    const fitting = Math.max(1, Math.floor((available + gap) / (columnMinimumWidth + gap)));
    // Ohne Abrunden: sonst ragt die nächste Spalte um den Rest in die Fläche
    width = (available - (fitting - 1) * gap) / fitting;
    addWidth = width;
  }
  const row = columnsElement.parentElement;
  row.style.setProperty("--column-width", `${width}px`);
  row.style.setProperty("--add-column-width", `${addWidth}px`);
  addColumnElement?.classList.toggle("is-wide", columnsElement.hidden || addWidth !== addColumnWidth);
}

function newColumnElement() {
  const input = h("input", {
    type: "text",
    class: "input",
    maxlength: String(columnTitleMaximum),
    placeholder: "Titel der Spalte",
    "aria-label": "Titel der neuen Spalte",
    required: true,
  });
  const form = h(
    "form",
    {
      class: "column-new is-editing",
      onsubmit: async (event) => {
        event.preventDefault();
        const title = input.value.trim();
        if (!title) {
          input.focus();
          return;
        }
        input.disabled = true;
        const created = await attempt(async () => {
          const column = await request("/api/board/columns", { method: "POST", body: { title } });
          board.columns.push({ id: column.id, title: column.title, cards: [] });
        }, "Spalte nicht angelegt.");
        if (!created) return;
        creatingColumn = true;
        draw({ focus: ".column-new input" });
        notify(`Spalte „${title}“ angelegt.`);
      },
      onkeydown: (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          creatingColumn = false;
          draw({ focus: '[data-focus-key="new-column"]' });
        }
      },
    },
    input,
    h(
      "div",
      { class: "inline-actions" },
      h(
        "button",
        {
          class: "button small",
          type: "button",
          onclick: () => {
            creatingColumn = false;
            draw({ focus: '[data-focus-key="new-column"]' });
          },
        },
        "Fertig",
      ),
      h("button", { class: "button small primary", type: "submit" }, "Anlegen"),
    ),
  );
  return form;
}

function startNewColumn() {
  if (!board) return;
  creatingColumn = true;
  draw({ focus: ".column-new input" });
  columnsElement.querySelector(".column-new")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", inline: "end", block: "nearest" });
}

function startRename(column) {
  const section = columnsElement.querySelector(`.column[data-column-id="${column.id}"]`);
  const heading = section?.querySelector(".column-title");
  if (!heading) return;
  const input = h("input", {
    type: "text",
    class: "input column-title-input",
    value: column.title,
    maxlength: String(columnTitleMaximum),
    "aria-label": "Neuer Titel der Spalte",
  });
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const title = input.value.trim();
    if (!save || !title || title === column.title) {
      draw({ focus: `[data-focus-key="menu-${column.id}"]` });
      return;
    }
    column.title = title;
    draw({ focus: `[data-focus-key="menu-${column.id}"]` });
    const saved = await attempt(() => request(`/api/board/columns/${column.id}`, { method: "PATCH", body: { title } }), "Umbenennen fehlgeschlagen.");
    if (saved) notify(`Umbenannt in „${title}“.`);
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  heading.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteColumn(column) {
  const count = column.cards.length;
  if (count > 0) {
    const confirmed = await confirmDialog({
      title: `Spalte „${column.title}“ mit ${plural(count, "Karte", "Karten")} löschen?`,
      confirmLabel: "Löschen",
    });
    if (!confirmed) return;
  }
  board.columns = board.columns.filter((entry) => entry !== column);
  draw({ focus: '[data-focus-key="new-column"]' });
  const deleted = await attempt(() => request(`/api/board/columns/${column.id}`, { method: "DELETE" }), "Löschen fehlgeschlagen.");
  if (deleted) notify(`Spalte „${column.title}“ gelöscht.`);
}

function shiftColumn(column, direction) {
  const index = board.columns.indexOf(column);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= board.columns.length) return;
  board.columns.splice(index, 1);
  board.columns.splice(target, 0, column);
  draw({ focus: `[data-focus-key="menu-${column.id}"]` });
  void moveColumnOnServer(column.id, target);
}

async function moveColumnOnServer(columnId, index) {
  await attempt(() => request(`/api/board/columns/${columnId}/move`, { method: "POST", body: { index } }), "Verschieben fehlgeschlagen.");
}

async function moveCardOnServer(cardId, columnId, index) {
  await attempt(
    () => request(`/api/board/cards/${cardId}/move`, { method: "POST", body: { column_id: columnId, index } }),
    "Verschieben fehlgeschlagen.",
  );
}

function toggleMenu(button, column, index) {
  if (openMenu?.button === button) {
    closeMenu({ restoreFocus: true });
    return;
  }
  closeMenu();
  const item = (label, action, { danger = false, disabled = false } = {}) =>
    h(
      "button",
      {
        class: danger ? "menu-item danger" : "menu-item",
        type: "button",
        role: "menuitem",
        disabled,
        onclick: () => {
          closeMenu();
          action();
        },
      },
      label,
    );
  const menu = h(
    "div",
    { class: "menu", role: "menu", "aria-label": `Spalte „${column.title}“` },
    item("Umbenennen", () => startRename(column)),
    item("Nach links", () => shiftColumn(column, -1), { disabled: index === 0 }),
    item("Nach rechts", () => shiftColumn(column, 1), { disabled: index === board.columns.length - 1 }),
    item("Spalte löschen", () => deleteColumn(column), { danger: true }),
  );
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll(".menu-item:not(:disabled)")];
    const position = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(position + step + items.length) % items.length]?.focus();
    } else if (event.key === "Tab") {
      closeMenu();
    }
  });
  button.setAttribute("aria-expanded", "true");
  button.closest(".column-head").append(menu);
  openMenu = { button, menu };
  menu.querySelector(".menu-item:not(:disabled)")?.focus();
}

function closeMenu({ restoreFocus = false } = {}) {
  if (!openMenu) return;
  const { button, menu } = openMenu;
  openMenu = null;
  button.setAttribute("aria-expanded", "false");
  menu.remove();
  if (restoreFocus) button.focus();
}

function onOutsidePointer(event) {
  if (!openMenu) return;
  if (openMenu.menu.contains(event.target) || openMenu.button.contains(event.target)) return;
  closeMenu();
}

function onDocumentKey(event) {
  if (event.key === "Escape" && openMenu) {
    event.preventDefault();
    closeMenu({ restoreFocus: true });
  }
}

function openCardEditor(card, column) {
  const isNew = card == null;
  const titleInput = h("input", {
    id: "card-title",
    type: "text",
    class: "input",
    maxlength: String(cardTitleMaximum),
    value: card?.title ?? "",
    placeholder: "Optional",
  });
  const bodyInput = h("textarea", {
    id: "card-body",
    class: "input textarea mono-soft",
    maxlength: String(cardBodyMaximum),
    rows: "10",
    placeholder: "Markdown",
  });
  bodyInput.value = card?.body ?? "";
  const columnSelect = h(
    "select",
    { id: "card-column", class: "input" },
    board.columns.map((entry) => h("option", { value: String(entry.id), selected: entry === column }, entry.title)),
  );
  const initialColor = cardColor(card);
  const colorPicker = h(
    "fieldset",
    { class: "color-picker" },
    h("legend", {}, "Farbe"),
    h(
      "div",
      { class: "color-options" },
      cardColors.map((color) =>
        h(
          "label",
          { class: "color-option", title: color.label },
          h("input", { type: "radio", name: "card-color", value: color.value, checked: color.value === initialColor, class: "color-input" }),
          h("span", { class: "color-swatch", "data-color": color.value, "aria-hidden": "true" }),
          h("span", { class: "visually-hidden" }, color.label),
        ),
      ),
    ),
  );
  const selectedColor = () => colorPicker.querySelector(".color-input:checked")?.value ?? "default";
  const preview = h("div", { class: "card-preview markdown", id: "card-preview", role: "tabpanel", "aria-labelledby": "tab-preview", hidden: true });
  const errorBox = h("p", { class: "form-error", role: "alert" });
  const counter = h("span", { class: "muted mono field-counter", "aria-live": "off" });
  const updateCounter = () => {
    counter.textContent = `${bodyInput.value.length.toLocaleString("de-DE")} / ${cardBodyMaximum.toLocaleString("de-DE")}`;
  };
  updateCounter();
  bodyInput.addEventListener("input", updateCounter);

  const writeTab = h("button", { class: "tab", type: "button", role: "tab", id: "tab-write", "aria-selected": "true", "aria-controls": "card-body" }, "Schreiben");
  const previewTab = h("button", { class: "tab", type: "button", role: "tab", id: "tab-preview", "aria-selected": "false", "aria-controls": "card-preview", tabindex: "-1" }, "Vorschau");
  const showPreview = (visible) => {
    writeTab.setAttribute("aria-selected", String(!visible));
    previewTab.setAttribute("aria-selected", String(visible));
    writeTab.tabIndex = visible ? -1 : 0;
    previewTab.tabIndex = visible ? 0 : -1;
    bodyInput.hidden = visible;
    preview.hidden = !visible;
    if (visible) {
      preview.replaceChildren(bodyInput.value.trim() ? renderMarkdown(bodyInput.value) : h("p", { class: "muted" }, "Leer."));
    }
  };
  writeTab.addEventListener("click", () => {
    showPreview(false);
    bodyInput.focus();
  });
  previewTab.addEventListener("click", () => showPreview(true));
  const tabList = h("div", { class: "tabs", role: "tablist", "aria-label": "Text" }, writeTab, previewTab);
  tabList.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const toPreview = previewTab.getAttribute("aria-selected") !== "true";
    showPreview(toPreview);
    (toPreview ? previewTab : writeTab).focus();
  });

  const original = { title: card?.title ?? "", body: card?.body ?? "", color: initialColor, columnId: column.id };
  let saved = card;
  let moving = false;
  const isDirty = () =>
    titleInput.value !== original.title ||
    bodyInput.value !== original.body ||
    selectedColor() !== original.color ||
    Number(columnSelect.value) !== original.columnId;

  const saveButton = h(
    "button",
    { class: "button primary", type: "submit", title: "⌘/Strg + Enter", "aria-keyshortcuts": "Meta+Enter Control+Enter" },
    isNew ? "Anlegen" : "Speichern",
  );
  let closing = false;
  const close = (focusKey) => {
    closing = true;
    dialog.close();
    dialog.remove();
    const target = focusKey ? columnsElement?.querySelector(`[data-focus-key="${focusKey}"]`) : null;
    target?.focus();
  };
  const requestClose = async () => {
    if (isDirty()) {
      const discard = await confirmDialog({ title: "Änderungen verwerfen?", confirmLabel: "Verwerfen" });
      if (!discard) return;
    }
    close(isNew ? `add-${column.id}` : `card-${card.id}`);
  };

  const save = async () => {
    const title = titleInput.value.trim();
    const body = bodyInput.value.replace(/\s+$/, "");
    const color = selectedColor();
    const targetColumn = findColumn(Number(columnSelect.value)) ?? column;
    if (!title && !body.trim()) {
      errorBox.textContent = "Titel oder Text eingeben.";
      titleInput.focus();
      return;
    }
    errorBox.textContent = "";
    saveButton.disabled = true;
    try {
      if (isNew) {
        const created = await request("/api/board/cards", { method: "POST", body: { column_id: targetColumn.id, title, body, color } });
        targetColumn.cards.push(created);
        close();
        draw({ focus: `[data-focus-key="card-${created.id}"]` });
        notify("Karte angelegt.");
        return;
      }
      // Karten immer über die ID suchen: Nach einem Teilfehler (PATCH ok,
      // Verschieben nicht) ist das alte Objekt schon ersetzt
      const holder = () => board?.columns.find((entry) => entry.cards.some((item) => item.id === saved.id)) ?? null;
      if (title !== saved.title || body !== saved.body || color !== cardColor(saved)) {
        const updated = await request(`/api/board/cards/${saved.id}`, { method: "PATCH", body: { title, body, color } });
        saved = { ...saved, ...updated };
        const owner = holder();
        if (owner) owner.cards = owner.cards.map((entry) => (entry.id === saved.id ? saved : entry));
        Object.assign(original, { title: saved.title, body: saved.body, color: cardColor(saved) });
      }
      const currentColumn = holder() ?? column;
      if (targetColumn.id !== currentColumn.id) {
        const index = targetColumn.cards.length;
        moving = true;
        await request(`/api/board/cards/${saved.id}/move`, { method: "POST", body: { column_id: targetColumn.id, index } });
        moving = false;
        currentColumn.cards = currentColumn.cards.filter((entry) => entry.id !== saved.id);
        targetColumn.cards.push(saved);
        original.columnId = targetColumn.id;
      }
      close();
      draw({ focus: `[data-focus-key="card-${saved.id}"]` });
      notify("Karte gespeichert.");
    } catch (error) {
      if (error instanceof SessionExpired) {
        saveButton.disabled = false;
        return;
      }
      errorBox.textContent = `Nicht gespeichert. ${errorMessage(error?.code)}`;
      saveButton.disabled = false;
      // Zielspalte kann serverseitig weg sein: Board neu laden, Editor bleibt offen
      if (moving) {
        moving = false;
        void reload();
      }
    }
  };

  const deleteButton = isNew
    ? null
    : h(
        "button",
        {
          class: "button danger",
          type: "button",
          onclick: async () => {
            const confirmed = await confirmDialog({ title: "Karte löschen?", confirmLabel: "Löschen" });
            if (!confirmed) return;
            column.cards = column.cards.filter((entry) => entry.id !== card.id);
            close();
            draw({ focus: `[data-focus-key="add-${column.id}"]` });
            const deleted = await attempt(() => request(`/api/board/cards/${card.id}`, { method: "DELETE" }), "Löschen fehlgeschlagen.");
            if (deleted) notify("Karte gelöscht.");
          },
        },
        "Löschen",
      );

  const form = h(
    "form",
    {
      class: "modal-body card-editor",
      onsubmit: (event) => {
        event.preventDefault();
        save();
      },
      onkeydown: (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save();
        }
      },
    },
    h(
      "div",
      { class: "modal-head" },
      h("h2", { id: "card-editor-title" }, isNew ? "Neue Karte" : "Karte bearbeiten"),
      h("button", { class: "icon-button", type: "button", "aria-label": "Schließen", onclick: requestClose }, icon("close", 18)),
    ),
    h("label", { for: "card-title" }, "Titel"),
    titleInput,
    colorPicker,
    h("div", { class: "field-row" }, h("label", { for: "card-body" }, "Text"), tabList),
    bodyInput,
    preview,
    h("div", { class: "field-hint" }, counter),
    h("label", { for: "card-column" }, "Spalte"),
    columnSelect,
    errorBox,
    h("div", { class: "modal-actions" }, deleteButton, h("span", { class: "spacer" }), h("button", { class: "button", type: "button", onclick: requestClose }, "Abbrechen"), saveButton),
  );

  const dialog = h("dialog", { class: "modal card-dialog", "aria-labelledby": "card-editor-title" }, form);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!closing) requestClose();
  });
  signal?.addEventListener("abort", () => {
    if (dialog.isConnected) {
      closing = true;
      dialog.close();
      dialog.remove();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  (isNew ? bodyInput : titleInput).focus();
}
