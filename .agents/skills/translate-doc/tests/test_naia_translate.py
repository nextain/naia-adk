import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "naia_translate.py"
SPEC = importlib.util.spec_from_file_location("naia_translate", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class TranslateDocTests(unittest.TestCase):
    def test_naia_key_is_canonical_and_aliases_are_compatible(self):
        with patch.dict(MODULE.os.environ, {
            "NAIA_KEY": "canonical",
            "NAIA_API_KEY": "api-alias",
            "NAIA_ANYLLM_API_KEY": "legacy-alias",
        }, clear=True):
            self.assertEqual(MODULE.api_key(), "canonical")
        with patch.dict(MODULE.os.environ, {"NAIA_API_KEY": "api-alias"}, clear=True):
            self.assertEqual(MODULE.api_key(), "api-alias")
        with patch.dict(MODULE.os.environ, {"NAIA_ANYLLM_API_KEY": "legacy-alias"}, clear=True):
            self.assertEqual(MODULE.api_key(), "legacy-alias")

    def test_concurrency_is_bounded(self):
        self.assertEqual(MODULE.checked_concurrency(4), 4)
        for value in (0, 17):
            with self.assertRaises(SystemExit):
                MODULE.checked_concurrency(value)

    def test_provider_qualified_price_matches_catalog_key(self):
        rows = [{"model_key": "azure:deepseek-v4-flash", "input_price_per_million": 0.209}]
        self.assertEqual(MODULE.model_price("deepseek-v4-flash", rows), rows[0])

    def test_ambiguous_provider_prices_fail_closed(self):
        rows = [{"model_key": "xai:grok-4.3"}, {"model_key": "azure:grok-4.3"}]
        self.assertIsNone(MODULE.model_price("grok-4.3", rows))

    def test_chunking_is_complete_and_ordered(self):
        source = "first paragraph\n\n" + "middle " * 500 + "\n\nlast paragraph"
        parts = MODULE.split_text(source, 1000)
        self.assertEqual(" ".join(" ".join(parts).split()), " ".join(source.split()))
        self.assertTrue(all(part.strip() for part in parts))

    def test_changed_extraction_cannot_resume_by_chunk_count_alone(self):
        self.assertNotEqual(MODULE.digest("first".encode()), MODULE.digest("other".encode()))

    def test_verification_binds_input_chunks_and_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "source.txt"; source.write_text("source", encoding="utf-8")
            chunks = root / "job/chunks"; chunks.mkdir(parents=True); chunk = chunks / "00001.ko.md"; chunk.write_text("번역", encoding="utf-8")
            output = root / "job/translation.ko.md"; output.write_text("번역", encoding="utf-8")
            manifest = {"input_path": str(source), "input_sha256": MODULE.file_digest(source), "chunk_count": 1, "chunks": [{"index": 1, "status": "complete", "output_sha256": MODULE.file_digest(chunk)}], "outputs": {output.name: MODULE.file_digest(output)}}
            (root / "job/manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            (root / "job/receipt.json").write_text("{}", encoding="utf-8")
            self.assertTrue(MODULE.verify(root / "job")["ok"])

    def test_pdf_renderer_embeds_readable_korean(self):
        try:
            import fitz
        except ImportError:
            self.skipTest("PyMuPDF not installed")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.pdf"
            MODULE.render_pdf("# 제목\n\n한국어 번역 확인", path, "제목")
            self.assertGreater(path.stat().st_size, 1000)
            with fitz.open(path) as document:
                self.assertIn("한국어 번역 확인", "".join(page.get_text() for page in document))


if __name__ == "__main__":
    unittest.main()
