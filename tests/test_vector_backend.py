import importlib
import os
import unittest
from unittest.mock import patch


class VectorBackendTests(unittest.TestCase):
    def test_cloud_backend_is_selected_when_pinecone_is_configured(self):
        import quran_backend.quran_backend.app.quran_service as quran_service

        with patch.dict(os.environ, {"PINECONE_API_KEY": "test-key", "PINECONE_INDEX": "quran-embeddings"}, clear=False):
            quran_service = importlib.reload(quran_service)
            with patch.object(quran_service, "pinecone", create=True) as pinecone_mod:
                pinecone_mod.Pinecone.return_value.Index.return_value = object()
                backend = quran_service.get_vector_backend()
                self.assertEqual(backend["type"], "pinecone")


if __name__ == "__main__":
    unittest.main()
