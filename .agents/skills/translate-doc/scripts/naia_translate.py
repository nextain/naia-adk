#!/usr/bin/env python3
"""Resumable document translation through the Naia gateway."""
from __future__ import annotations

import argparse, hashlib, html, json, os, re, sys, time
import urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_BASE = "https://api.nextain.io/v1"
DEFAULT_MODEL = "deepseek-v4-flash"
KEY_ENVS = ("NAIA_KEY", "NAIA_API_KEY", "NAIA_ANYLLM_API_KEY")

def now() -> str: return datetime.now(timezone.utc).isoformat()
def digest(data: bytes) -> str: return hashlib.sha256(data).hexdigest()
def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def settings() -> dict[str, Any]:
    candidates = [Path.cwd() / "naia-settings/config.json"]
    candidates += [p / "naia-settings/config.json" for p in Path(__file__).resolve().parents]
    for path in candidates:
        if path.is_file():
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                return value if isinstance(value, dict) else {}
            except (OSError, json.JSONDecodeError): return {}
    return {}

def base_url(explicit: str | None) -> str:
    value = explicit or os.getenv("NAIA_BASE_URL") or os.getenv("NAIA_ANYLLM_BASE_URL") or settings().get("naiaGatewayUrl") or DEFAULT_BASE
    value = str(value).rstrip("/")
    return value if value.endswith("/v1") else value + "/v1"

def api_key() -> str:
    for name in KEY_ENVS:
        if os.getenv(name): return str(os.environ[name]).strip()
    raise SystemExit("Naia API key not found. Set NAIA_KEY in the process environment.")

def checked_concurrency(value: int) -> int:
    if not 1 <= value <= 16:
        raise SystemExit("--concurrency must be between 1 and 16")
    return value

def request(base: str, path: str, key: str | None = None, payload: dict[str, Any] | None = None) -> Any:
    data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": "naia-adk-translate-doc/1"}
    if data: headers["Content-Type"] = "application/json"
    if key: headers["Authorization"] = f"Bearer {key}"
    for attempt in range(5):
        try:
            req = urllib.request.Request(base + "/" + path.lstrip("/"), data=data, headers=headers, method="POST" if data else "GET")
            with urllib.request.urlopen(req, timeout=240) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:500]
            if exc.code not in (408, 429, 500, 502, 503, 504) or attempt == 4:
                raise RuntimeError(f"Naia API HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 4: raise RuntimeError(f"Naia API connection failed: {exc}") from exc
        time.sleep(min(2 ** attempt, 16))
    raise AssertionError("unreachable")

def models(base: str) -> list[dict[str, Any]]:
    value = request(base, "models")
    if not isinstance(value, list): raise RuntimeError("Unexpected /models response")
    return value

def pricing(base: str) -> list[dict[str, Any]]:
    value = request(base, "pricing")
    if not isinstance(value, list): raise RuntimeError("Unexpected /pricing response")
    return value

def choose_model(explicit: str | None, rows: list[dict[str, Any]]) -> str:
    config = settings()
    chosen = explicit or (config.get("memoryLlmModel") if config.get("memoryLlmProvider") == "naia" else None) or os.getenv("NAIA_MODEL")
    live = {r.get("model_key") for r in rows if "llm" in r.get("capabilities", []) and r.get("operational_status") in (None, "live")}
    chosen = chosen or (DEFAULT_MODEL if DEFAULT_MODEL in live else sorted(live)[0] if live else None)
    if chosen not in live: raise RuntimeError(f"Model is not a live text model in the Naia catalog: {chosen}")
    return str(chosen)

def read_source(path: Path, extracted: Path | None) -> str:
    if extracted: return extracted.read_text(encoding="utf-8")
    if path.suffix.lower() in (".txt", ".md", ".markdown"): return path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".pdf":
        try: import fitz
        except ImportError as exc: raise SystemExit("PDF support requires: python -m pip install pymupdf") from exc
        doc = fitz.open(path)
        return "\n\n".join(f"<!-- source-page: {i + 1} -->\n\n{page.get_text('text')}" for i, page in enumerate(doc))
    raise SystemExit("Unsupported input type. Use --source-text with read-doc output.")

def split_text(text: str, limit: int) -> list[str]:
    if limit < 1000: raise SystemExit("--chunk-chars must be at least 1000")
    result, current = [], ""
    for part in re.split(r"(\n\s*\n)", text):
        if len(current) + len(part) <= limit: current += part; continue
        if current.strip(): result.append(current.strip())
        while len(part) > limit:
            cut = max(part.rfind("\n", 0, limit), part.rfind(" ", 0, limit))
            if cut < limit // 2: cut = limit
            result.append(part[:cut].strip()); part = part[cut:].lstrip()
        current = part
    if current.strip(): result.append(current.strip())
    return result

def model_price(model: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    # The public catalog uses route keys (for example deepseek-v4-flash), while
    # billing rows may use provider-qualified keys (azure:deepseek-v4-flash).
    # Prefer an exact row, then a unique qualified suffix.
    exact = next((r for r in rows if r.get("model_key") == model), None)
    if exact: return exact
    matches = [r for r in rows if str(r.get("model_key", "")).endswith(":" + model)]
    return matches[0] if len(matches) == 1 else None

def estimate(text: str, price: dict[str, Any] | None) -> dict[str, Any]:
    inp, out = max(1, round(len(text) / 3.2)), max(1, round(len(text) / 3.2 * 1.15))
    value: dict[str, Any] = {"method": "character heuristic", "input_characters": len(text), "estimated_input_tokens": inp, "estimated_output_tokens": out}
    if price and price.get("pricing_unit", "per_token") == "per_token":
        usd = (inp * float(price["input_price_per_million"]) + out * float(price["output_price_per_million"])) / 1_000_000
        value.update(estimated_usd=round(usd, 6), estimated_credits=round(usd * 1000, 3))
    return value

def translate_chunk(base: str, key: str, model: str, text: str, index: int, total: int) -> dict[str, Any]:
    system = ("Translate the supplied document chunk into Korean (한국어). Return only the translation. "
              "Preserve headings, lists, tables, code, URLs, names, numbers, footnotes, and HTML source-page comments. "
              "Do not summarize, omit, add commentary, or translate code identifiers. Translate exactly what is present.")
    response = request(base, "chat/completions", key, {"model": model, "temperature": 0.1, "messages": [
        {"role": "system", "content": system}, {"role": "user", "content": f"Document chunk {index}/{total}:\n\n{text}"}]})
    try: content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc: raise RuntimeError("Completion response lacks translated content") from exc
    if not isinstance(content, str) or not content.strip(): raise RuntimeError("Naia returned an empty translation")
    return {"content": content.strip(), "model": response.get("model", model), "usage": response.get("usage", {})}

def to_html(markdown: str, title: str) -> str:
    body = html.escape(markdown)
    for level in range(6, 0, -1): body = re.sub(rf"^{'#' * level} (.+)$", rf"<h{level}>\1</h{level}>", body, flags=re.M)
    body = body.replace("\n\n", "</p><p>").replace("\n", "<br>\n")
    return f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{html.escape(title)}</title><style>@page{{size:A4;margin:20mm}}body{{font-family:"Malgun Gothic","Noto Sans KR",sans-serif;max-width:48rem;margin:auto;line-height:1.75}}code,pre{{font-family:monospace;white-space:pre-wrap}}</style></head><body><p>{body}</p></body></html>'''

def render_pdf(markdown: str, path: Path, title: str) -> None:
    try: import fitz
    except ImportError as exc: raise RuntimeError("PDF rendering requires PyMuPDF") from exc
    candidates = [Path(os.getenv("WINDIR", "C:/Windows")) / "Fonts/malgun.ttf", Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")]
    font = next((p for p in candidates if p.is_file()), None)
    if not font: raise RuntimeError("No Korean-capable PDF font found")
    doc = fitz.open(); page = None; y = 52
    fontname = "ko"
    # PyMuPDF's Story handles pagination and font fallback more reliably than manual text boxes.
    css = f"@font-face{{font-family:ko;src:url('{font.as_posix()}')}}body{{font-family:ko;font-size:9.5pt;line-height:1.55}}"
    story = fitz.Story(html=to_html(markdown, title), user_css=css)
    writer = fitz.DocumentWriter(str(path)); box = fitz.paper_rect("a4"); area = box + (48, 48, -48, -48); more = True
    while more:
        device = writer.begin_page(box); more, _ = story.place(area); story.draw(device); writer.end_page()
    writer.close()

def write_outputs(out: Path, text: str, title: str, formats: set[str]) -> dict[str, str]:
    result = {}
    for kind, name in (("markdown", "translation.ko.md"), ("html", "translation.ko.html")):
        if kind in formats:
            path = out / name; path.write_text(text if kind == "markdown" else to_html(text, title), encoding="utf-8"); result[name] = file_digest(path)
    if "pdf" in formats:
        path = out / "translation.ko.pdf"; render_pdf(text, path, title); result[path.name] = file_digest(path)
    return result

def verify(out: Path) -> dict[str, Any]:
    manifest_path, receipt_path = out / "manifest.json", out / "receipt.json"
    if not manifest_path.is_file() or not receipt_path.is_file(): raise RuntimeError("manifest.json or receipt.json is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")); failures = []
    source = Path(manifest["input_path"])
    if not source.is_file() or file_digest(source) != manifest["input_sha256"]: failures.append("input digest mismatch")
    extracted_path = manifest.get("source_text_path")
    if extracted_path:
        extracted = Path(extracted_path)
        if not extracted.is_file() or digest(extracted.read_text(encoding="utf-8").encode()) != manifest["source_text_sha256"]:
            failures.append("extracted source text digest mismatch")
    if [row.get("index") for row in manifest["chunks"]] != list(range(1, manifest["chunk_count"] + 1)):
        failures.append("chunk indexes are not contiguous and ordered")
    for row in manifest["chunks"]:
        path = out / "chunks" / f"{row['index']:05d}.ko.md"
        if row.get("status") != "complete" or not path.is_file() or not path.read_text(encoding="utf-8").strip(): failures.append(f"chunk {row['index']} incomplete")
        elif file_digest(path) != row.get("output_sha256"): failures.append(f"chunk {row['index']} digest mismatch")
    for name, expected in manifest.get("outputs", {}).items():
        path = out / name
        if not path.is_file() or file_digest(path) != expected: failures.append(f"output mismatch: {name}")
    report = {"ok": not failures, "checked_at": now(), "chunk_count": len(manifest["chunks"]), "failures": failures}
    (out / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if failures: raise RuntimeError("Verification failed: " + "; ".join(failures))
    return report

def run_translate(args: argparse.Namespace) -> None:
    source_path = Path(args.input).resolve()
    if not source_path.is_file(): raise SystemExit(f"Input not found: {source_path}")
    extracted_path = Path(args.source_text).resolve() if args.source_text else None
    text = read_source(source_path, extracted_path)
    base = base_url(args.base_url); catalog = models(base); model = choose_model(args.model, catalog)
    catalog_row = next(r for r in catalog if r.get("model_key") == model); price = model_price(model, pricing(base))
    if not price and not args.allow_unpriced: raise SystemExit(f"No live price for {model}; use --allow-unpriced only after accepting unknown cost")
    key = api_key(); out = Path(args.output_dir).resolve(); chunk_dir = out / "chunks"; chunk_dir.mkdir(parents=True, exist_ok=True)
    parts = split_text(text, args.chunk_chars); manifest_path = out / "manifest.json"; source_hash = file_digest(source_path)
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest["input_sha256"], manifest["source_text_sha256"], manifest["model"], manifest["chunk_chars"], manifest["chunk_count"]) != (source_hash, digest(text.encode()), model, args.chunk_chars, len(parts)):
            raise SystemExit("Existing manifest does not match this job; use another output directory")
    else:
        manifest = {"schema_version": 1, "created_at": now(), "updated_at": now(), "input_path": str(source_path), "input_sha256": source_hash,
                    "source_text_path": str(extracted_path) if extracted_path else None,
                    "source_text_sha256": digest(text.encode()), "base_url": base, "model": model, "model_catalog_snapshot": catalog_row,
                    "pricing_snapshot": price, "chunk_chars": args.chunk_chars, "chunk_count": len(parts), "chunks": [], "outputs": {}}
        manifest["chunks"] = [{"index": i, "input_sha256": digest(part.encode()), "status": "pending"} for i, part in enumerate(parts, 1)]
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    concurrency = checked_concurrency(args.concurrency)
    before = request(base, "profile/balance", key)
    if "balance_before_raw" not in manifest:
        manifest["balance_before_raw"] = before.get("data", {}).get("balance")
        manifest["updated_at"] = now(); manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    jobs: list[tuple[int, str]] = []
    for i, part in enumerate(parts, 1):
        row, path = manifest["chunks"][i - 1], chunk_dir / f"{i:05d}.ko.md"
        if row.get("status") == "complete" and path.is_file() and file_digest(path) == row.get("output_sha256"):
            print(f"[{i}/{len(parts)}] reuse", flush=True); continue
        jobs.append((i, part))
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="naia-translate") as executor:
        futures = {}
        for i, part in jobs:
            print(f"[{i}/{len(parts)}] queued", flush=True)
            futures[executor.submit(translate_chunk, base, key, model, part, i, len(parts))] = i
        for future in as_completed(futures):
            i = futures[future]; result = future.result(); path = chunk_dir / f"{i:05d}.ko.md"; row = manifest["chunks"][i - 1]
            path.write_text(result["content"] + "\n", encoding="utf-8")
            row.update(status="complete", completed_at=now(), output_sha256=file_digest(path), actual_model=result["model"], usage=result["usage"])
            manifest["updated_at"] = now(); manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[{i}/{len(parts)}] complete", flush=True)
    translated = "\n\n".join((chunk_dir / f"{i:05d}.ko.md").read_text(encoding="utf-8").strip() for i in range(1, len(parts) + 1))
    formats = {x.strip() for x in args.format.split(",") if x.strip()}
    if formats - {"markdown", "html", "pdf"}: raise SystemExit("Unknown output format")
    manifest["outputs"] = write_outputs(out, translated, args.title or source_path.stem, formats); manifest["updated_at"] = now()
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    after = request(base, "profile/balance", key); usage = {k: sum(int(r.get("usage", {}).get(k, 0) or 0) for r in manifest["chunks"]) for k in ("prompt_tokens", "completion_tokens", "total_tokens")}
    before_raw = manifest.get("balance_before_raw"); after_raw = after.get("data", {}).get("balance")
    before_credits = float(before_raw) / 100_000 if before_raw is not None else None
    after_credits = float(after_raw) / 100_000 if after_raw is not None else None
    receipt = {"completed_at": now(), "model_requested": model, "models_reported": sorted({r.get("actual_model", model) for r in manifest["chunks"]}),
               "usage": usage, "balance_before_raw": before.get("data", {}).get("balance"), "balance_after_raw": after.get("data", {}).get("balance"),
               "credits_before": before_credits, "credits_after": after_credits,
               "credits_consumed": round(before_credits - after_credits, 6) if before_credits is not None and after_credits is not None else None,
               "pricing_snapshot": price, "input_sha256": source_hash, "output_sha256": manifest["outputs"]}
    (out / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(verify(out), ensure_ascii=False, indent=2))

def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__); p.add_argument("--base-url"); sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("models"); sub.add_parser("pricing"); sub.add_parser("check")
    e = sub.add_parser("estimate"); e.add_argument("input"); e.add_argument("--source-text"); e.add_argument("--model")
    t = sub.add_parser("translate"); t.add_argument("input"); t.add_argument("--source-text"); t.add_argument("--output-dir", required=True); t.add_argument("--model")
    t.add_argument("--chunk-chars", type=int, default=18000); t.add_argument("--concurrency", type=int, default=4); t.add_argument("--format", default="markdown,html,pdf"); t.add_argument("--title"); t.add_argument("--allow-unpriced", action="store_true")
    v = sub.add_parser("verify"); v.add_argument("--output-dir", required=True)
    return p

def main() -> int:
    args = parser().parse_args(); base = base_url(args.base_url)
    if args.command == "models": print(json.dumps(models(base), ensure_ascii=False, indent=2))
    elif args.command == "pricing": print(json.dumps(pricing(base), ensure_ascii=False, indent=2))
    elif args.command == "check":
        value = request(base, "profile/balance", api_key()); raw = float(value.get("data", {}).get("balance", 0))
        print(json.dumps({"ok": True, "credits": round(raw / 100_000, 3), "note": "converted from legacy micro-dollar field"}, indent=2))
    elif args.command == "estimate":
        path = Path(args.input).resolve(); text = read_source(path, Path(args.source_text).resolve() if args.source_text else None); catalog = models(base); model = choose_model(args.model, catalog); price = model_price(model, pricing(base))
        print(json.dumps({"model": model, "pricing": price, "estimate": estimate(text, price)}, ensure_ascii=False, indent=2))
    elif args.command == "translate": run_translate(args)
    else: print(json.dumps(verify(Path(args.output_dir).resolve()), ensure_ascii=False, indent=2))
    return 0

if __name__ == "__main__":
    try: raise SystemExit(main())
    except (RuntimeError, OSError, json.JSONDecodeError) as exc: print(f"error: {exc}", file=sys.stderr); raise SystemExit(1)
