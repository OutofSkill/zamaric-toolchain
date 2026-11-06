import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.js";

export const demo = new URLSearchParams(location.search).has("demo");

const root = document.getElementById("app");
const sessionCheckIntervalMs = 60 * 1000;

const routes = [
  { id: "overview", label: "Übersicht", icon: "overview", module: "./overview.js", render: "renderOverview" },
  { id: "board", label: "Board", icon: "board", module: "./board.js", render: "renderBoard" },
  { id: "repo", label: "Repo", icon: "repo", module: "./views.js", render: "renderRepo" },
  { id: "database", label: "Datenbank", icon: "database", module: "./views.js", render: "renderDatabase" },
  { id: "messages", label: "Nachrichten", icon: "messages", module: "./views.js", render: "renderMessages" },
  { id: "server", label: "Server", icon: "server", module: "./views.js", render: "renderServer" },
];

const errorMessages = {
  unauthorized: "Abgemeldet.",
  forbidden: "Kein Admin-Account.",
  invalid_credentials: "Passwort falsch.",
  too_many_attempts: "Zu viele Versuche, kurz warten.",
  invalid_request: "Eingabe ungültig.",
  not_found: "Nicht gefunden.",
  method_not_allowed: "Aktion nicht erlaubt.",
  internal_error: "Serverfehler, siehe Log.",
  database_failed: "Supabase nicht erreichbar.",
  storage_failed: "Speicher nicht erreichbar.",
  repo_unavailable: "Repo nicht gefunden (REPO_PATH prüfen).",
  github_failed: "GitHub nicht erreichbar oder Token abgelehnt.",
  not_configured: "Nicht eingerichtet.",
  timeout: "Zeitüberschreitung.",
  too_large: "Zu groß.",
  api_unreachable: "API nicht erreichbar.",
  network: "Pi nicht erreichbar.",
};

let signedIn = false;
let loginDialog = null;
let viewController = null;
let shell = null;

export class SessionExpired extends Error {
  constructor() {
    super("unauthorized");
    this.code = "unauthorized";
  }
}

export class RequestError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "style") element.style.cssText = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (typeof value !== "string" && key in element) element[key] = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function svg(name, size = 18) {
  const namespace = "http://www.w3.org/2000/svg";
  const element = document.createElementNS(namespace, "svg");
  element.setAttribute("viewBox", "0 0 24 24");
  element.setAttribute("width", String(size));
  element.setAttribute("height", String(size));
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("focusable", "false");
  element.setAttribute("class", "icon");
  for (const path of iconPaths[name] ?? []) {
    const shape = document.createElementNS(namespace, "path");
    shape.setAttribute("d", path);
    element.append(shape);
  }
  return element;
}

const iconPaths = {
  overview: ["M4 4h7v7H4z", "M13 4h7v4h-7z", "M13 10h7v10h-7z", "M4 13h7v7H4z"],
  board: ["M4 5h4v14H4z", "M10 5h4v9h-4z", "M16 5h4v11h-4z"],
  repo: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"],
  database: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
  messages: ["M4 5h16v11H8l-4 4z"],
  server: ["M3 12h4l3-8 4 16 3-8h4"],
  plus: ["M12 5v14", "M5 12h14"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  grip: ["M9 6h.01", "M15 6h.01", "M9 12h.01", "M15 12h.01", "M9 18h.01", "M15 18h.01"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  logout: ["M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3", "M10 17l5-5-5-5", "M15 12H4"],
  sidebar: ["M4 5h16v14H4z", "M9 5v14"],
};

export function icon(name, size) {
  return svg(name, size);
}

export function errorMessage(code) {
  return Object.hasOwn(errorMessages, code) ? errorMessages[code] : "Unbekannter Fehler.";
}

async function readError(response) {
  try {
    const body = await response.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // Antwort ohne JSON, z. B. eine Fehlerseite von nginx
  }
  // nginx antwortet so, wenn Container 2 nicht läuft oder nicht antwortet
  if ([502, 503, 504].includes(response.status)) return "api_unreachable";
  return response.status >= 500 ? "internal_error" : "invalid_request";
}

export async function request(path, options = {}) {
  const { body, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();
  const init = { credentials: "same-origin", ...rest, method, headers: { Accept: "application/json", ...(rest.headers ?? {}) } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  if (demo) {
    const { demoResponse } = await import("./demo.js");
    return demoResponse(path, init);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new RequestError("network", 0);
  }
  if (response.status === 401 && path !== "/api/login") {
    renderLogin(errorMessages.unauthorized);
    throw new SessionExpired();
  }
  if (!response.ok) {
    throw new RequestError(await readError(response), response.status);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const dateFormat = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

const relativeFormat = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto", style: "short" });

export function formatDate(value) {
  if (!value) return "–";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "–" : dateFormat.format(date);
}

export function formatRelative(value, now = new Date()) {
  if (!value) return "–";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const steps = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Infinity, "year"],
  ];
  let amount = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(amount) < size) return relativeFormat.format(Math.round(amount), unit);
    amount /= size;
  }
  return formatDate(date);
}

const berlinDayFormat = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin" });

// Kalendertag in Berlin als fortlaufende Zahl, damit "morgen" der nächste Tag ist und nicht "in 24 Stunden"
function berlinDayNumber(date) {
  const [year, month, day] = berlinDayFormat.format(date).split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86400000);
}

// Vergangene Zeitpunkte wie formatRelative, künftige als "in 3 Std.",
// ab einem anderen Kalendertag als "morgen", "übermorgen", "in 4 Tagen"
export function describeTime(iso, now = new Date()) {
  if (!iso) return "–";
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return "–";
  const seconds = (date.getTime() - now.getTime()) / 1000;
  if (seconds <= 30) return formatRelative(date, now);
  const days = berlinDayNumber(date) - berlinDayNumber(now);
  if (days >= 1) return relativeFormat.format(days, "day");
  for (const [unit, size] of [["hour", 3600], ["minute", 60]]) {
    if (seconds >= size) return relativeFormat.format(Math.floor(seconds / size), unit);
  }
  return relativeFormat.format(Math.round(seconds), "second");
}

const numberFormat = new Intl.NumberFormat("de-DE");

export function formatNumber(value) {
  return value == null ? "–" : numberFormat.format(value);
}

export function formatBytes(bytes) {
  if (bytes == null) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export function renderMarkdown(markdown) {
  const html = marked.parse(markdown ?? "", { gfm: true, breaks: true, async: false });
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ["style", "form", "input", "button"] });
  // Fremde und relative Bilder blockt die CSP ohnehin, statt kaputter Bilder steht der Alt-Text da
  for (const image of fragment.querySelectorAll("img")) {
    if (!(image.getAttribute("src") ?? "").startsWith("data:image/")) {
      image.replaceWith(document.createTextNode(image.getAttribute("alt") ?? ""));
    }
  }
  return fragment;
}

export function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function confirmDialog({ title, message, confirmLabel = "Löschen", danger = true }) {
  return new Promise((resolve) => {
    const confirmButton = h("button", { class: danger ? "button danger" : "button primary", type: "submit", value: "confirm" }, confirmLabel);
    const dialog = h(
      "dialog",
      { class: "modal confirm-dialog", "aria-labelledby": "confirm-title" },
      h(
        "form",
        { method: "dialog", class: "modal-body" },
        h("h2", { id: "confirm-title" }, title),
        message ? h("p", { class: "muted" }, message) : null,
        h(
          "div",
          { class: "modal-actions" },
          h("button", { class: "button", type: "submit", value: "cancel" }, "Abbrechen"),
          confirmButton,
        ),
      ),
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    confirmButton.focus();
  });
}

function currentRoute() {
  const id = location.hash.replace(/^#/, "").split("/")[0];
  return routes.find((route) => route.id === id) ?? routes[0];
}

function navigation() {
  return h(
    "nav",
    { class: "nav", "aria-label": "Bereiche" },
    h(
      "ul",
      {},
      routes.map((route) =>
        h("li", {}, h("a", { href: `#${route.id}`, class: "nav-link", "data-route": route.id }, svg(route.icon), h("span", { class: "nav-label" }, route.label))),
      ),
    ),
  );
}

// Eingeklappte Seitenleiste: nur Symbole, Namen als Tooltip. Gilt nur ab
// 900 px, darunter gibt es die Leiste oben.
const sidebarStorageKey = "zamaric-dev.sidebar";
const wideScreen = window.matchMedia("(min-width: 900px)");

function storedSidebarCollapsed() {
  try {
    return localStorage.getItem(sidebarStorageKey) === "collapsed";
  } catch {
    return false;
  }
}

function sidebarCollapsed() {
  return shell?.element.classList.contains("sidebar-collapsed") ?? false;
}

function setSidebarCollapsed(collapsed, { remember = true } = {}) {
  if (!shell) return;
  shell.element.classList.toggle("sidebar-collapsed", collapsed);
  shell.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  shell.sidebarToggle.setAttribute("aria-label", collapsed ? "Seitenleiste ausklappen" : "Seitenleiste einklappen");
  shell.sidebarToggle.querySelector(".nav-label").textContent = collapsed ? "Ausklappen [" : "Einklappen [";
  if (!remember) return;
  try {
    localStorage.setItem(sidebarStorageKey, collapsed ? "collapsed" : "expanded");
  } catch {
    // Ohne Speicher gilt der Zustand nur bis zum Neuladen
  }
}

function toggleSidebarByKey(event) {
  // Auf deutschen Mac-Tastaturen braucht „[“ die Wahltaste, deshalb zählt altKey nicht
  if (event.key !== "[" || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
  if (!shell || !wideScreen.matches || document.querySelector("dialog[open]")) return;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), dialog")) return;
  event.preventDefault();
  setSidebarCollapsed(!sidebarCollapsed());
}

function buildShell() {
  const main = h("main", { class: "view", id: "view", tabindex: "-1" });
  const logoutButton = demo
    ? h("span", { class: "chip muted demo-chip" }, "Demo")
    : h("button", { class: "nav-logout", type: "button", onclick: logout, "aria-label": "Abmelden" }, svg("logout"), h("span", { class: "nav-label", "aria-hidden": "true" }, "Abmelden"));
  const sidebarToggle = h(
    "button",
    { class: "sidebar-toggle", type: "button", "aria-keyshortcuts": "[", onclick: () => setSidebarCollapsed(!sidebarCollapsed()) },
    svg("sidebar"),
    h("span", { class: "nav-label", "aria-hidden": "true" }),
  );
  const element = h(
    "div",
    { class: "shell" },
    h(
      "header",
      { class: "sidebar" },
      h(
        "div",
        { class: "sidebar-top" },
        h("a", { class: "brand", href: "#overview", "aria-label": "Zamaric Dev, zur Übersicht" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", { class: "brand-name" }, "zamaric"), h("span", { class: "brand-tag mono" }, "dev")),
        sidebarToggle,
      ),
      navigation(),
      h("div", { class: "sidebar-end" }, logoutButton),
    ),
    main,
  );
  return { element, main, sidebarToggle };
}

async function renderRoute({ focus = false } = {}) {
  if (!signedIn) return;
  if (!shell) {
    shell = buildShell();
    setSidebarCollapsed(storedSidebarCollapsed(), { remember: false });
    root.replaceChildren(shell.element);
    // Erst nach dem ersten Bild animieren, sonst klappt die gemerkte Leiste beim Laden sichtbar ein
    requestAnimationFrame(() => requestAnimationFrame(() => shell?.element.classList.add("shell-ready")));
  }
  const route = currentRoute();
  for (const link of shell.element.querySelectorAll(".nav-link")) {
    if (link.dataset.route === route.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `${route.label} · Zamaric Dev`;
  viewController?.abort();
  viewController = new AbortController();
  const signal = viewController.signal;
  const container = h("div", { class: "view-inner", "data-route": route.id }, h("p", { class: "loading" }, "Lädt …"));
  shell.main.replaceChildren(container);
  if (focus) shell.main.focus({ preventScroll: true });
  try {
    const module = await import(route.module);
    if (signal.aborted) return;
    await module[route.render](container, { signal });
  } catch (error) {
    if (error instanceof SessionExpired || error?.name === "AbortError" || signal.aborted) return;
    console.error(error);
    container.replaceChildren(
      h(
        "div",
        { class: "page" },
        h("h1", { class: "visually-hidden" }, route.label),
        h(
          "div",
          { class: "error-box", role: "alert" },
          h("p", {}, errorMessage(error?.code)),
          h("button", { class: "button small", type: "button", onclick: () => renderRoute() }, "Erneut versuchen"),
        ),
      ),
    );
  }
}

function renderLogin(notice = null) {
  signedIn = false;
  if (loginDialog?.open) {
    loginDialog.querySelector(".form-error").textContent = notice ?? "";
    return;
  }
  if (!shell) root.replaceChildren(h("div", { class: "login-backdrop", "aria-hidden": "true" }));
  const passwordInput = h("input", { id: "password", type: "password", autocomplete: "current-password", required: true });
  const errorBox = h("p", { class: "form-error", role: "alert" }, notice ?? "");
  const submit = h("button", { class: "button primary", type: "submit" }, "Anmelden");
  const form = h(
    "form",
    {
      class: "modal-body login",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        errorBox.textContent = "";
        try {
          await request("/api/login", { method: "POST", body: { password: passwordInput.value } });
          dialog.close();
          dialog.remove();
          loginDialog = null;
          await start();
          return;
        } catch (error) {
          errorBox.textContent = error?.code === "unauthorized" || error?.code === "invalid_credentials"
            ? errorMessages.invalid_credentials
            : errorMessage(error?.code);
        }
        submit.disabled = false;
        passwordInput.select();
      },
    },
    h("p", { class: "login-brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }), h("span", { class: "brand-name" }, "zamaric"), h("span", { class: "brand-tag mono" }, "dev")),
    h("h1", { id: "login-title" }, "Anmelden"),
    h("label", { for: "password" }, "Passwort"),
    passwordInput,
    errorBox,
    submit,
  );
  const dialog = h("dialog", { class: "modal login-dialog", "aria-labelledby": "login-title", oncancel: (event) => event.preventDefault() }, form);
  loginDialog = dialog;
  document.body.append(dialog);
  dialog.showModal();
  passwordInput.focus();
}

async function logout() {
  try {
    await request("/api/logout", { method: "POST" });
  } catch (error) {
    if (error instanceof SessionExpired) return;
  }
  viewController?.abort();
  shell = null;
  renderLogin();
}

async function checkSession() {
  if (demo || !signedIn) return;
  await request("/api/session").catch(() => null);
}

async function start() {
  if (!demo) {
    try {
      await request("/api/session");
    } catch (error) {
      if (error instanceof SessionExpired) return;
      root.replaceChildren(
        h(
          "main",
          { class: "unreachable" },
          h(
            "section",
            { class: "panel" },
            h("h1", {}, "Server nicht erreichbar"),
            h("p", { class: "muted" }, errorMessage(error?.code)),
            h("button", { class: "button primary", type: "button", onclick: start }, "Erneut versuchen"),
          ),
        ),
      );
      return;
    }
  }
  signedIn = true;
  await renderRoute();
}

window.addEventListener("hashchange", () => renderRoute({ focus: true }));
document.addEventListener("keydown", toggleSidebarByKey);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkSession();
});
setInterval(() => {
  if (document.visibilityState === "visible") checkSession();
}, sessionCheckIntervalMs);

start();
