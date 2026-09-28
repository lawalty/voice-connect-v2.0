import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("verification", Path(__file__).with_name("verify-library-agent.py"))
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)


class LibraryAcceptanceTests(unittest.TestCase):
    def result(self, name, data):
        return {"toolName": name, "isError": False, "content": [{"type": "text", "text": json.dumps(data)}]}

    def test_outer_success_does_not_hide_plugin_error_text(self):
        result = self.result("vc_library_search", {})
        result["content"][0]["text"] = "The library is temporarily unavailable. Please try again."
        with self.assertRaisesRegex(AssertionError, "non-JSON"):
            verification.library_data(result)

    def test_empty_or_error_shaped_json_is_not_search_evidence(self):
        for value in ({"error": "unavailable"}, {"hits": []}, {"hits": [{"document_id": "doc"}]}):
            with self.assertRaises(AssertionError):
                verification.library_data(self.result("vc_library_search", value))

    def test_real_document_and_chunk_payloads_are_accepted(self):
        for name, value in (
            ("vc_library_groups", [{"id": "group", "slug": "work"}]),
            ("vc_library_documents", [{"id": "doc", "filename": "Example.pdf"}]),
            ("vc_library_search", {"hits": [{"document_id": "doc", "content": "Evidence", "chunk_index": 0}]}),
        ):
            self.assertEqual(verification.library_data(self.result(name, value)), value)


if __name__ == "__main__":
    unittest.main()
