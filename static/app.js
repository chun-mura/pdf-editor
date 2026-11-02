const state = {
  id: null,
  name: "",
  pages: [],
  page: 0,
  zoom: 1.5,
  tool: "text",
  items: [],
  selected: null,
  sprites: {},
  nextId: 1,
};

const $ = (id) => document.getElementById(id);
let spriteTimer = 0;
let drag = null;
let past = [];
let future = [];
let dragDepth = 0;
let restoring = false;

function say(message) {
  $("status").textContent = message || "";
}

function pageSize() {
  return state.pages[state.page];
}

function selectedItem() {
  return state.items.find((item) => item.id === state.selected) || null;
}

async function openFile(file) {
  say("読み込んでいます。");
  const response = await fetch("/api/open", {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  const payload = await response.json();
  if (!response.ok) {
    say(payload.error || "開けませんでした。");
    return;
  }
  state.id = payload.id;
  state.name = file.name;
  state.pages = payload.pages;
  state.page = 0;
  state.items = [];
  state.selected = null;
  state.sprites = {};
  past = [];
  future = [];
  $("doc-name").textContent = file.name;
  $("pager").hidden = false;
  $("export").disabled = false;
  $("empty").hidden = true;
  $("sheet-wrap").hidden = false;
  say("");
  render();
}

function setTool(tool) {
  const removed = tool !== state.tool && discardEmptyText();
  state.tool = tool;
  $("tool-text").classList.toggle("is-on", tool === "text");
  $("tool-rect").classList.toggle("is-on", tool === "rect");
  $("tool-text").setAttribute("aria-pressed", String(tool === "text"));
  $("tool-rect").setAttribute("aria-pressed", String(tool === "rect"));
  $("mode-hint").textContent = tool === "text"
    ? "クリックしたところが、1行目の左下です。"
    : "ドラッグした範囲を白で覆います。書き出したPDFでは、その欄は出ません。";
  if (removed) render();
}

function render() {
  const sheet = $("sheet");
  const size = pageSize();
  if (!size) return;
  const zoom = state.zoom;
  sheet.style.width = `${size.width * zoom}px`;
  sheet.style.height = `${size.height * zoom}px`;
  const pageUrl = `/api/page/${state.id}/${state.page}.png?zoom=${zoom}`;
  let img = sheet.querySelector("img.page");
  if (!img) {
    img = document.createElement("img");
    img.className = "page";
    img.alt = "";
    sheet.appendChild(img);
  }
  if (img.dataset.src !== pageUrl) {
    img.dataset.src = pageUrl;
    img.src = pageUrl;
  }
  img.width = Math.round(size.width * zoom);
  img.height = Math.round(size.height * zoom);

  let layer = sheet.querySelector(".overlay");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "overlay";
    sheet.appendChild(layer);
  }
  layer.replaceChildren();
  for (const item of state.items) {
    if (item.page !== state.page) continue;
    layer.appendChild(renderItem(item, zoom));
  }
  $("page-label").textContent = `${state.page + 1} / ${state.pages.length}`;
  $("prev").disabled = state.page <= 0;
  $("next").disabled = state.page >= state.pages.length - 1;
  renderInspector();
  renderPlaced();
  syncHistory();
  scheduleSprites();
}

function renderItem(item, zoom) {
  const node = document.createElement("div");
  node.className = `item ${item.type}${item.id === state.selected ? " is-selected" : ""}`;
  node.dataset.id = String(item.id);
  if (item.type === "rect") {
    node.style.left = `${item.x * zoom}px`;
    node.style.top = `${item.y * zoom}px`;
    node.style.width = `${item.w * zoom}px`;
    node.style.height = `${item.h * zoom}px`;
    return node;
  }
  const sprite = state.sprites[item.id];
  if (sprite && sprite.text === item.text && sprite.size === item.size && sprite.zoom === zoom) {
    node.style.left = `${(item.x - sprite.ax) * zoom}px`;
    node.style.top = `${(item.y - sprite.ay) * zoom}px`;
    node.style.width = `${sprite.w * zoom}px`;
    node.style.height = `${sprite.h * zoom}px`;
    const image = document.createElement("img");
    image.alt = "";
    image.src = `data:image/png;base64,${sprite.png}`;
    node.appendChild(image);
  } else {
    node.style.left = `${item.x * zoom}px`;
    node.style.top = `${(item.y - item.size) * zoom}px`;
    node.style.height = `${item.size * zoom}px`;
    const mark = document.createElement("div");
    mark.className = "baseline";
    mark.style.width = `${item.size * zoom}px`;
    node.appendChild(mark);
  }
  return node;
}

function renderInspector() {
  const host = $("inspector");
  const item = selectedItem();
  if (!item) {
    if (host.dataset.mode !== "empty") {
      host.dataset.mode = "empty";
      host.replaceChildren();
      const lead = document.createElement("p");
      lead.className = "quiet";
      lead.textContent = "足した文字の内容と大きさは、ここで変えます。";
      host.append(lead);
    }
    return;
  }
  if (host.dataset.mode !== `${item.type}:${item.id}`) {
    host.dataset.mode = `${item.type}:${item.id}`;
    host.replaceChildren();
    if (item.type === "text") host.append(textInspector(item));
    else host.append(rectInspector(item));
    return;
  }
  if (item.type === "text") {
    const area = host.querySelector("textarea");
    if (area && area.value !== item.text && (restoring || document.activeElement !== area)) area.value = item.text;
    syncNumber(host.querySelector("[data-key='size']"), item.size);
  }
  syncNumber(host.querySelector("[data-key='x']"), item.x);
  syncNumber(host.querySelector("[data-key='y']"), item.y);
  if (item.type === "rect") {
    syncNumber(host.querySelector("[data-key='w']"), item.w);
    syncNumber(host.querySelector("[data-key='h']"), item.h);
  }
}

function syncNumber(input, value) {
  if (!input || document.activeElement === input) return;
  const shown = Number(input.value);
  const next = round(value);
  if (shown !== next) input.value = String(next);
}

function textInspector(item) {
  const wrap = document.createElement("div");
  const textLabel = field("内容");
  const area = document.createElement("textarea");
  area.value = item.text;
  let checkpoint = false;
  area.addEventListener("input", () => {
    if (!checkpoint) {
      remember();
      checkpoint = true;
    }
    item.text = area.value;
    render();
  });
  textLabel.append(area);

  const sizeLabel = field("大きさ（ポイント）");
  const row = document.createElement("div");
  row.className = "size-row";
  const size = numberInput("size", item.size, 6, 32, 0.5);
  const minus = document.createElement("button");
  minus.type = "button";
  minus.textContent = "小さく";
  minus.addEventListener("click", () => {
    remember();
    setSize(item, item.size - 0.5);
  });
  const plus = document.createElement("button");
  plus.type = "button";
  plus.textContent = "大きく";
  plus.addEventListener("click", () => {
    remember();
    setSize(item, item.size + 0.5);
  });
  row.append(size, minus, plus);
  sizeLabel.append(row);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "この文字を消す";
  remove.addEventListener("click", () => removeSelected());
  wrap.append(textLabel, sizeLabel, positionFields(item), remove);
  return wrap;
}

function rectInspector(item) {
  const wrap = document.createElement("div");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "この白枠を消す";
  remove.addEventListener("click", () => removeSelected());
  wrap.append(positionFields(item), sizeFields(item), remove);
  return wrap;
}

function positionFields(item) {
  const pair = document.createElement("div");
  pair.className = "pair";
  const yLabel = item.type === "text" ? "1行目の下" : "上";
  pair.append(labeledNumber("左", "x", item.x), labeledNumber(yLabel, "y", item.y));
  return pair;
}

function sizeFields(item) {
  const pair = document.createElement("div");
  pair.className = "pair";
  pair.append(labeledNumber("幅", "w", item.w), labeledNumber("高さ", "h", item.h));
  return pair;
}

function labeledNumber(label, key, value) {
  const box = field(label);
  box.append(numberInput(key, value, -2000, 5000, 0.5));
  return box;
}

function field(label) {
  const box = document.createElement("label");
  box.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  box.append(span);
  return box;
}

function numberInput(key, value, min, max, step) {
  const input = document.createElement("input");
  input.type = "number";
  input.dataset.key = key;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(round(value));
  let checkpoint = false;
  input.addEventListener("input", () => {
    const item = selectedItem();
    if (!item) return;
    const next = Number(input.value);
    if (!Number.isFinite(next)) return;
    if (!checkpoint) {
      remember();
      checkpoint = true;
    }
    if (key === "size") setSize(item, next);
    else {
      item[key] = next;
      render();
    }
  });
  return input;
}

function setSize(item, size) {
  item.size = clampSize(size);
  render();
}

function clampSize(size) {
  const stepped = Math.round(size * 2) / 2;
  return Math.min(32, Math.max(6, stepped));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function snapshot() {
  return JSON.stringify({ items: state.items, selected: state.selected });
}

function remember() {
  past.push(snapshot());
  if (past.length > 80) past.shift();
  future = [];
  syncHistory();
}

function undo() {
  if (!past.length || drag) return;
  future.push(snapshot());
  applySnapshot(past.pop());
}

function redo() {
  if (!future.length || drag) return;
  past.push(snapshot());
  applySnapshot(future.pop());
}

function applySnapshot(raw) {
  const data = JSON.parse(raw);
  restoring = true;
  state.items = data.items;
  state.selected = data.selected;
  render();
  restoring = false;
}

function syncHistory() {
  $("undo").disabled = past.length === 0;
  $("redo").disabled = future.length === 0;
}

function renderPlaced() {
  const wrap = $("placed-wrap");
  const host = $("placed");
  const visible = state.items.filter((item) => item.page === state.page);
  if (!visible.length) {
    wrap.hidden = true;
    host.replaceChildren();
    return;
  }
  wrap.hidden = false;
  host.replaceChildren();
  for (const item of visible) {
    const button = document.createElement("button");
    button.type = "button";
    const label = item.type === "rect"
      ? "白"
      : (item.text.trim().split("\n")[0] || "文字");
    button.textContent = label.length > 18 ? `${label.slice(0, 18)}…` : label;
    button.classList.toggle("is-on", item.id === state.selected);
    button.addEventListener("click", () => {
      if (state.selected !== item.id) discardEmptyText();
      state.selected = item.id;
      render();
      const node = $("sheet").querySelector(`[data-id="${item.id}"]`);
      if (node) node.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    host.append(button);
  }
}

function scheduleSprites() {
  window.clearTimeout(spriteTimer);
  spriteTimer = window.setTimeout(loadSprites, 120);
}

async function loadSprites() {
  if (!state.id) return;
  const zoom = state.zoom;
  const pending = state.items.filter((item) => {
    if (item.type !== "text" || item.page !== state.page || !item.text.trim()) return false;
    const sprite = state.sprites[item.id];
    return !sprite || sprite.text !== item.text || sprite.size !== item.size || sprite.zoom !== zoom;
  });
  if (!pending.length) return;
  const response = await fetch("/api/sprites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      zoom,
      items: pending.map((item) => ({ id: item.id, text: item.text, size: item.size })),
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    say(payload.error || "文字を描けませんでした。");
    return;
  }
  for (const item of pending) {
    const sprite = payload.sprites[String(item.id)] || payload.sprites[item.id];
    if (!sprite) continue;
    state.sprites[item.id] = { ...sprite, text: item.text, size: item.size, zoom };
  }
  if (!drag) render();
}

function pointFromEvent(event) {
  const rect = $("sheet").getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / state.zoom,
    y: (event.clientY - rect.top) / state.zoom,
  };
}

function discardEmptyText(quiet) {
  const item = selectedItem();
  if (!item || item.type !== "text" || item.text.length !== 0) return false;
  if (!quiet) remember();
  state.items = state.items.filter((entry) => entry.id !== item.id);
  delete state.sprites[item.id];
  if (state.selected === item.id) state.selected = null;
  return true;
}

function addText(x, y) {
  remember();
  discardEmptyText(true);
  const item = {
    id: state.nextId++,
    type: "text",
    page: state.page,
    x,
    y,
    text: "",
    size: 10,
  };
  state.items.push(item);
  state.selected = item.id;
  render();
  const area = $("inspector").querySelector("textarea");
  if (area) area.focus();
}

function addRect(x, y, w, h) {
  remember();
  const item = {
    id: state.nextId++,
    type: "rect",
    page: state.page,
    x,
    y,
    w,
    h,
  };
  state.items.push(item);
  state.selected = item.id;
  render();
}

function removeSelected() {
  const id = state.selected;
  if (id == null) return;
  remember();
  state.items = state.items.filter((item) => item.id !== id);
  delete state.sprites[id];
  state.selected = null;
  render();
}

function nudge(dx, dy) {
  const item = selectedItem();
  if (!item) return;
  remember();
  item.x += dx;
  item.y += dy;
  render();
}

function placeNode(node, item) {
  const zoom = state.zoom;
  if (item.type === "rect") {
    node.style.left = `${item.x * zoom}px`;
    node.style.top = `${item.y * zoom}px`;
    return;
  }
  const sprite = state.sprites[item.id];
  if (sprite && sprite.text === item.text && sprite.size === item.size && sprite.zoom === zoom) {
    node.style.left = `${(item.x - sprite.ax) * zoom}px`;
    node.style.top = `${(item.y - sprite.ay) * zoom}px`;
    return;
  }
  node.style.left = `${item.x * zoom}px`;
  node.style.top = `${(item.y - item.size) * zoom}px`;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const hit = event.target.closest(".item");
  if (hit && !hit.classList.contains("ghost")) {
    const id = Number(hit.dataset.id);
    if (state.selected !== id) discardEmptyText();
    state.selected = id;
    const item = selectedItem();
    drag = {
      kind: "move",
      id,
      originX: item.x,
      originY: item.y,
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
    render();
    const node = $("sheet").querySelector(`[data-id="${id}"]`);
    if (node) node.setPointerCapture(event.pointerId);
    return;
  }
  const point = pointFromEvent(event);
  if (state.tool === "text") {
    addText(point.x, point.y);
    return;
  }
  discardEmptyText();
  drag = { kind: "rect", pointerId: event.pointerId, x: point.x, y: point.y };
  $("sheet").setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!drag) return;
  if (drag.kind === "move") {
    const item = state.items.find((entry) => entry.id === drag.id);
    const node = $("sheet").querySelector(`[data-id="${drag.id}"]`);
    if (!item || !node) return;
    if (!drag.remembered) {
      remember();
      drag.remembered = true;
    }
    item.x = drag.originX + (event.clientX - drag.pointerX) / state.zoom;
    item.y = drag.originY + (event.clientY - drag.pointerY) / state.zoom;
    placeNode(node, item);
    syncNumber($("inspector").querySelector("[data-key='x']"), item.x);
    syncNumber($("inspector").querySelector("[data-key='y']"), item.y);
    return;
  }
  const point = pointFromEvent(event);
  let ghost = $("sheet").querySelector(".ghost");
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.className = "item rect ghost";
    $("sheet").querySelector(".overlay").appendChild(ghost);
  }
  const x = Math.min(drag.x, point.x);
  const y = Math.min(drag.y, point.y);
  const w = Math.abs(point.x - drag.x);
  const h = Math.abs(point.y - drag.y);
  ghost.style.left = `${x * state.zoom}px`;
  ghost.style.top = `${y * state.zoom}px`;
  ghost.style.width = `${w * state.zoom}px`;
  ghost.style.height = `${h * state.zoom}px`;
  drag.box = { x, y, w, h };
}

function onPointerUp() {
  if (!drag) return;
  const finished = drag;
  drag = null;
  if (finished.kind === "rect" && finished.box && finished.box.w > 1 && finished.box.h > 1) {
    addRect(finished.box.x, finished.box.y, finished.box.w, finished.box.h);
    return;
  }
  render();
}

async function exportPdf() {
  if (!state.id) return;
  say("書き出しています。");
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: state.id, items: state.items }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    say(payload.error || "書き出せませんでした。");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stem = state.name.replace(/\.pdf$/i, "");
  const filename = `${stem}-追記.pdf`;
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  say(`${filename} を書き出しました。元のPDFはそのままです。`);
}

$("open").addEventListener("click", () => $("file").click());
$("open-empty").addEventListener("click", () => $("file").click());
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("file").addEventListener("change", () => {
  const file = $("file").files && $("file").files[0];
  if (file) openFile(file);
  $("file").value = "";
});
$("prev").addEventListener("click", () => {
  if (state.page > 0) {
    state.page -= 1;
    render();
  }
});
$("next").addEventListener("click", () => {
  if (state.page < state.pages.length - 1) {
    state.page += 1;
    render();
  }
});
$("zoom").addEventListener("change", () => {
  state.zoom = Number($("zoom").value);
  render();
});
$("export").addEventListener("click", exportPdf);
$("tool-text").addEventListener("click", () => setTool("text"));
$("tool-rect").addEventListener("click", () => setTool("rect"));
$("sheet").addEventListener("pointerdown", onPointerDown);
$("sheet").addEventListener("pointermove", onPointerMove);
$("sheet").addEventListener("pointerup", onPointerUp);
$("sheet").addEventListener("pointercancel", onPointerUp);

document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  const typing = event.target instanceof Element && event.target.matches("textarea, input, select");
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !typing) {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y" && !typing) {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key === "Escape") {
    state.selected = null;
    render();
    return;
  }
  if ((event.key === "Backspace" || event.key === "Delete") && !typing) {
    removeSelected();
    event.preventDefault();
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.code === "KeyT") {
    setTool("text");
    return;
  }
  if (event.code === "KeyW") {
    setTool("rect");
    return;
  }
  const step = event.shiftKey ? 5 : 0.5;
  const move = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }[event.key];
  if (!move) return;
  event.preventDefault();
  nudge(move[0], move[1]);
});

document.addEventListener("pointerdown", (event) => {
  const path = event.composedPath();
  if (path.includes($("sheet")) || path.includes($("inspector")) || path.includes($("placed")) || path.includes($("undo")) || path.includes($("redo"))) return;
  const item = selectedItem();
  if (!item || item.type !== "text" || item.text.length !== 0) return;
  discardEmptyText();
  render();
});

window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer || ![...event.dataTransfer.types].includes("Files")) return;
  dragDepth += 1;
  document.body.classList.add("is-dropping");
  event.preventDefault();
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("is-dropping");
  }
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("is-dropping");
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name))) openFile(file);
});
