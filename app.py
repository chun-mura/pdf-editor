#!/usr/bin/env python3
"""Local tool that places text and white rectangles on a PDF.

The page image and the exported file are both drawn by PyMuPDF, so a click
lands on the same point that is written into the file. Text size is in
typographic points. The anchor of a text item is the left end of the first
line's baseline, measured from the top-left of the page.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import pymupdf

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8734
MAX_UPLOAD = 40 * 1024 * 1024
MIN_SIZE = 6.0
MAX_SIZE = 32.0
LEADING = 1.15

_lock = threading.Lock()
_sessions: dict[str, dict] = {}
_origin_top: bool | None = None
_font_path: str | None = None


def find_font() -> str:
    names = []
    roots = [
        Path("/System/Library/Fonts"),
        Path("/System/Library/Fonts/Supplemental"),
        Path.home() / "Library/Fonts",
    ]
    for root in roots:
        if not root.is_dir():
            continue
        for name in os.listdir(root):
            if name.endswith("明朝 ProN.ttc"):
                names.append(str(root / name))
    if not names:
        raise FileNotFoundError(
            "ヒラギノ明朝 ProN が見つかりません。Mac の標準フォントが必要です。"
        )
    return names[0]


def font_path() -> str:
    global _font_path
    if _font_path is None:
        _font_path = find_font()
    return _font_path


def origin_is_top() -> bool:
    """PyMuPDF 1.28 draws with y growing downward. Recheck so a future
    library change does not silently flip every overlay."""
    global _origin_top
    if _origin_top is not None:
        return _origin_top
    doc = pymupdf.open()
    page = doc.new_page(width=100, height=100)
    page.draw_rect(pymupdf.Rect(10, 10, 30, 20), fill=(0, 0, 0), color=None)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False)
    top = bottom = 0
    samples = pix.samples
    width = pix.width
    for y in range(pix.height):
        for x in range(width):
            i = (y * width + x) * 3
            if samples[i] < 30 and samples[i + 1] < 30 and samples[i + 2] < 30:
                if y < pix.height / 2:
                    top += 1
                else:
                    bottom += 1
    _origin_top = top > bottom
    return _origin_top


def pdf_y(page_height: float, y_from_top: float) -> float:
    if origin_is_top():
        return y_from_top
    return page_height - y_from_top


def pdf_rect(page_height: float, x: float, y: float, w: float, h: float) -> pymupdf.Rect:
    if origin_is_top():
        return pymupdf.Rect(x, y, x + w, y + h)
    return pymupdf.Rect(x, page_height - (y + h), x + w, page_height - y)


def shared_font() -> pymupdf.Font:
    return pymupdf.Font(fontfile=font_path())


def open_document(data: bytes) -> pymupdf.Document:
    doc = pymupdf.open(stream=data, filetype="pdf")
    if doc.needs_pass or doc.is_encrypted:
        if not doc.authenticate(""):
            raise PermissionError(
                "このPDFは開くためのパスワードが必要です。空のパスワードでは開けません。"
            )
    if doc.page_count < 1:
        raise ValueError("ページがありません。")
    return doc


def render_page(doc: pymupdf.Document, index: int, zoom: float) -> bytes:
    page = doc[index]
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    return pix.tobytes("png")


def render_sprite(text: str, size: float, zoom: float) -> dict | None:
    lines = text.split("\n")
    if not any(line.strip() for line in lines):
        return None
    font = shared_font()
    asc = font.ascender * size
    desc = abs(font.descender) * size
    leading = size * LEADING
    width = max((font.text_length(line, fontsize=size) for line in lines), default=1.0)
    width = max(width, 1.0)
    height = asc + desc + leading * (len(lines) - 1)
    pad = 2.0
    page_w = width + pad * 2
    page_h = height + pad * 2
    doc = pymupdf.open()
    page = doc.new_page(width=page_w, height=page_h)
    page.insert_font(fontname="mincho", fontfile=font_path())
    anchor_x = pad
    anchor_y = pad + asc
    for i, line in enumerate(lines):
        if not line:
            continue
        baseline = anchor_y + i * leading
        page.insert_text(
            (anchor_x, pdf_y(page_h, baseline)),
            line,
            fontname="mincho",
            fontsize=size,
            color=(0, 0, 0),
        )
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=True)
    return {
        "png": base64.b64encode(pix.tobytes("png")).decode("ascii"),
        "ax": anchor_x,
        "ay": anchor_y,
        "w": page_w,
        "h": page_h,
    }


def text_cover(page_height: float, item: dict) -> pymupdf.Rect | None:
    text = str(item.get("text") or "")
    lines = text.split("\n")
    if not any(line.strip() for line in lines):
        return None
    font = shared_font()
    size = clamp_size(item.get("size"))
    width = max((font.text_length(line, fontsize=size) for line in lines), default=1.0)
    width = max(width, 1.0)
    asc = font.ascender * size
    desc = abs(font.descender) * size
    height = asc + desc + size * LEADING * (len(lines) - 1)
    return pdf_rect(page_height, float(item["x"]), float(item["y"]) - asc, width, height)


def hide_covered_widgets(page: pymupdf.Page, covers: list[pymupdf.Rect]) -> None:
    """Form fields are drawn after page content, so an overlay sitting on a
    field never appears in print. Hide a field only when a white rectangle or
    a text run actually lands on it. The stored value is left as it was."""
    if not covers:
        return
    doc = page.parent
    for widget in page.widgets() or []:
        field = widget.rect
        if field.is_empty or field.get_area() <= 0:
            continue
        for cover in covers:
            overlap = field & cover
            if overlap.is_empty:
                continue
            area = overlap.get_area()
            if area >= field.get_area() * 0.35 or area >= cover.get_area() * 0.5:
                doc.xref_set_key(widget.xref, "F", "2")
                break


def export_pdf(source: bytes, items: list[dict]) -> bytes:
    doc = open_document(source)
    by_page: dict[int, list[dict]] = {}
    for item in items:
        by_page.setdefault(int(item["page"]), []).append(item)
    for index, group in by_page.items():
        if index < 0 or index >= doc.page_count:
            continue
        page = doc[index]
        height = float(page.rect.height)
        covers: list[pymupdf.Rect] = []
        for item in group:
            if item["type"] == "rect":
                covers.append(
                    pdf_rect(height, float(item["x"]), float(item["y"]), float(item["w"]), float(item["h"]))
                )
            elif item["type"] == "text":
                cover = text_cover(height, item)
                if cover is not None:
                    covers.append(cover)
        hide_covered_widgets(page, covers)
        needs_font = any(item["type"] == "text" and str(item.get("text") or "").strip() for item in group)
        if needs_font:
            page.insert_font(fontname="mincho", fontfile=font_path())
        for item in group:
            if item["type"] == "rect":
                page.draw_rect(
                    pdf_rect(height, float(item["x"]), float(item["y"]), float(item["w"]), float(item["h"])),
                    fill=(1, 1, 1),
                    color=None,
                    width=0,
                    overlay=True,
                )
            elif item["type"] == "text":
                text = str(item.get("text") or "")
                size = clamp_size(item.get("size"))
                leading = size * LEADING
                x = float(item["x"])
                y = float(item["y"])
                for i, line in enumerate(text.split("\n")):
                    if not line:
                        continue
                    baseline = y + i * leading
                    page.insert_text(
                        (x, pdf_y(height, baseline)),
                        line,
                        fontname="mincho",
                        fontsize=size,
                        color=(0, 0, 0),
                        overlay=True,
                    )
    return doc.tobytes(garbage=3, deflate=True, encryption=pymupdf.PDF_ENCRYPT_NONE)


def clamp_size(value) -> float:
    try:
        size = float(value)
    except (TypeError, ValueError):
        size = 10.0
    if size < MIN_SIZE:
        return MIN_SIZE
    if size > MAX_SIZE:
        return MAX_SIZE
    return round(size * 2) / 2


def clamp_zoom(value) -> float:
    try:
        zoom = float(value)
    except (TypeError, ValueError):
        zoom = 1.5
    if zoom < 0.5:
        return 0.5
    if zoom > 3:
        return 3.0
    return zoom


def parse_items(raw) -> list[dict]:
    if not isinstance(raw, list):
        raise ValueError("項目の形式が違います。")
    items = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("項目の形式が違います。")
        kind = item.get("type")
        page = int(item.get("page", 0))
        x = float(item.get("x", 0))
        y = float(item.get("y", 0))
        if kind == "text":
            text = str(item.get("text") or "")
            if len(text) > 2000:
                raise ValueError("文字が長すぎます。")
            items.append(
                {
                    "type": "text",
                    "page": page,
                    "x": x,
                    "y": y,
                    "text": text,
                    "size": clamp_size(item.get("size", 10)),
                }
            )
        elif kind == "rect":
            w = float(item.get("w", 0))
            h = float(item.get("h", 0))
            if w <= 0 or h <= 0:
                continue
            items.append({"type": "rect", "page": page, "x": x, "y": y, "w": w, "h": h})
        else:
            raise ValueError("未知の項目です。")
    return items


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def _send(self, code: int, body: bytes, content_type: str, filename: str | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{filename}")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_UPLOAD:
            raise ValueError("ファイルが大きすぎます。")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("形式が違います。")
        return data

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/", "/index.html"):
                body = (STATIC / "index.html").read_bytes()
                self._send(200, body, "text/html; charset=utf-8")
                return
            if path.startswith("/static/"):
                file_path = (STATIC / path.removeprefix("/static/")).resolve()
                if not file_path.is_relative_to(STATIC.resolve()) or not file_path.is_file():
                    self._json(404, {"error": "見つかりません。"})
                    return
                mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                self._send(200, file_path.read_bytes(), mime)
                return
            if path.startswith("/api/page/"):
                _prefix, _api, _page, sid, filename = path.split("/", 4)
                index = int(filename.removesuffix(".png"))
                zoom = 1.5
                query = parsed.query
                for part in query.split("&"):
                    if part.startswith("zoom="):
                        zoom = clamp_zoom(part.split("=", 1)[1])
                with _lock:
                    session = _sessions.get(sid)
                    if session is None:
                        self._json(404, {"error": "PDFが開かれていません。"})
                        return
                    png = render_page(open_document(session["data"]), index, zoom)
                self._send(200, png, "image/png")
                return
            self._json(404, {"error": "見つかりません。"})
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": str(exc)})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/open":
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_UPLOAD:
                    self._json(400, {"error": "PDFを読み取れません。"})
                    return
                data = self.rfile.read(length)
                name = unquote(self.headers.get("X-Filename", "document.pdf"))
                with _lock:
                    doc = open_document(data)
                    sid = uuid.uuid4().hex
                    pages = [
                        {"width": float(doc[i].rect.width), "height": float(doc[i].rect.height)}
                        for i in range(doc.page_count)
                    ]
                    _sessions[sid] = {"data": data, "name": name}
                self._json(200, {"id": sid, "name": name, "pages": pages})
                return
            if path == "/api/sprites":
                body = self._read_json()
                zoom = clamp_zoom(body.get("zoom", 1.5))
                result = {}
                with _lock:
                    for item in body.get("items") or []:
                        sprite = render_sprite(str(item.get("text") or ""), clamp_size(item.get("size", 10)), zoom)
                        if sprite is not None:
                            result[str(item.get("id"))] = sprite
                self._json(200, {"sprites": result})
                return
            if path == "/api/export":
                body = self._read_json()
                sid = str(body.get("id") or "")
                items = parse_items(body.get("items"))
                with _lock:
                    session = _sessions.get(sid)
                    if session is None:
                        self._json(404, {"error": "PDFが開かれていません。"})
                        return
                    pdf = export_pdf(session["data"], items)
                    stem = Path(session["name"]).stem
                filename = quote_filename(f"{stem}-追記.pdf")
                self._send(200, pdf, "application/pdf", filename)
                return
            self._json(404, {"error": "見つかりません。"})
        except PermissionError as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": str(exc)})


def quote_filename(name: str) -> str:
    from urllib.parse import quote

    return quote(name)


def self_check() -> None:
    origin_is_top()
    font = shared_font()
    assert font.text_length("区", fontsize=10) > 0
    doc = pymupdf.open()
    page = doc.new_page(width=240, height=160)
    page.insert_font(fontname="mincho", fontfile=font_path())
    page.insert_text((20, pdf_y(160, 30)), "元", fontname="mincho", fontsize=14)
    widget = pymupdf.Widget()
    widget.field_name = "addr"
    widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    widget.rect = pymupdf.Rect(40, 40, 180, 58)
    widget.field_value = "CLIPPED"
    widget.text_fontsize = 12
    widget.fill_color = (1, 1, 1)
    page.add_widget(widget)
    kept = pymupdf.Widget()
    kept.field_name = "kept"
    kept.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
    kept.rect = pymupdf.Rect(40, 110, 120, 128)
    kept.field_value = "KEEP"
    kept.text_fontsize = 12
    page.add_widget(kept)
    raw = doc.tobytes()
    covered = export_pdf(
        raw,
        [
            {"type": "rect", "page": 0, "x": 16, "y": 16, "w": 30, "h": 22},
            {"type": "rect", "page": 0, "x": 36, "y": 36, "w": 150, "h": 26},
            {"type": "text", "page": 0, "x": 40, "y": 70, "text": "中央区", "size": 12},
        ],
    )
    out = pymupdf.open(stream=covered, filetype="pdf")
    pix = out[0].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
    samples = pix.samples
    dark = []
    for y in range(pix.height):
        for x in range(pix.width):
            i = (y * pix.width + x) * 3
            if samples[i] < 40 and samples[i + 1] < 40 and samples[i + 2] < 40:
                dark.append((x, y))
    assert dark, "exported text produced no ink"
    xs = [p[0] for p in dark]
    ys = [p[1] for p in dark]
    # The covered glyph near the top should be gone; new text baseline is y=70pt.
    assert min(xs) > 50, (min(xs), max(xs), min(ys), max(ys))
    assert 70 * 2 - 30 <= min(ys) <= 70 * 2
    assert any(y > 200 for y in ys), "uncovered field was hidden"
    values = {widget.field_name: widget.field_value for widget in out[0].widgets()}
    assert values == {"addr": "CLIPPED", "kept": "KEEP"}
    flags = {widget.field_name: out.xref_get_key(widget.xref, "F")[1] for widget in out[0].widgets()}
    assert flags["addr"] == "2" and flags["kept"] != "2"
    sprite = render_sprite("中央区", 12, 2)
    assert sprite is not None and sprite["ay"] > 0
    print("self-check ok", "origin_top" if origin_is_top() else "origin_bottom")


def main() -> None:
    import sys

    if "--check" in sys.argv:
        self_check()
        return
    origin_is_top()
    font_path()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"開いています {url}")
    print("終了するときは Ctrl+C")
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了しました。")


if __name__ == "__main__":
    main()
