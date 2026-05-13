import unittest

import build_hf_model_pulse as hf


class HfModelPulseInferenceTest(unittest.TestCase):
    def test_infers_model_family(self):
        self.assertEqual(hf.infer_family("meta-llama/Llama-3.1-8B", []), "llama")
        self.assertEqual(hf.infer_family("BAAI/bge-large-en", []), "other")

    def test_parameter_hint_requires_segment_boundary(self):
        self.assertEqual(hf.infer_parameter_hint("org/gpt4-7b", []), "7B")
        self.assertEqual(hf.infer_parameter_hint("org/a123b", []), "")

    def test_publisher_uses_curated_namespace_only(self):
        self.assertEqual(hf.infer_publisher("google/gemma-2b", "google", []), ("Alphabet / Google", "GOOG"))
        self.assertEqual(hf.infer_publisher("some-org/gemma-2b", "some-org", []), ("some-org", ""))

    def test_topic_uses_quantization_signal(self):
        row = {"pipeline_tag": "text-generation", "model_family": "qwen", "tag_text": "gptq;4-bit"}
        flags = {"has_gguf": False}
        self.assertEqual(hf.infer_topic(row, flags), "local_llm_quantization")

    def test_downloads_per_like_handles_zero_likes(self):
        self.assertEqual(hf.downloads_per_like(100, 0), 0)
        self.assertEqual(hf.downloads_per_like(100, 4), 25)


if __name__ == "__main__":
    unittest.main()
