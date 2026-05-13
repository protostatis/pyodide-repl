#!/usr/bin/env python3
"""Build a public Hugging Face model pulse dataset.

Output: public/hf_model_pulse.csv
"""

from __future__ import annotations

import csv
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


BASE_URL = "https://huggingface.co/api/models"
OUT_PATH = Path("public/hf_model_pulse.csv")
AI_DEMAND_FACTS_PATH = Path("public/ai_demand_facts.csv")
USER_AGENT = "pyodide-repl hf model pulse builder"
PAGE_LIMIT = 100
MAX_ROWS = 10000


FAMILY_PATTERNS = [
    ("qwen", re.compile(r"qwen", re.I)),
    ("llama", re.compile(r"llama|codellama", re.I)),
    ("mistral", re.compile(r"mistral|mixtral", re.I)),
    ("gemma", re.compile(r"gemma", re.I)),
    ("bert", re.compile(r"\bbert\b|roberta|deberta|electra", re.I)),
    ("t5", re.compile(r"\bt5\b|flan", re.I)),
    ("stable-diffusion", re.compile(r"stable-diffusion|sdxl|flux", re.I)),
    ("whisper", re.compile(r"whisper", re.I)),
    ("clip", re.compile(r"\bclip\b", re.I)),
]

PUBLISHER_PATTERNS = [
    ("Meta", "META", re.compile(r"meta|facebook|llama", re.I)),
    ("Alphabet / Google", "GOOG", re.compile(r"google|deepmind|gemma", re.I)),
    ("Microsoft", "MSFT", re.compile(r"microsoft|msft|phi", re.I)),
    ("Amazon", "AMZN", re.compile(r"amazon|aws|titan", re.I)),
    ("NVIDIA", "NVDA", re.compile(r"nvidia|nemotron|nemo", re.I)),
    ("Oracle", "ORCL", re.compile(r"oracle", re.I)),
    ("Alibaba / Qwen", "BABA", re.compile(r"alibaba|qwen|damo", re.I)),
    ("OpenAI", "", re.compile(r"openai|gpt-oss", re.I)),
    ("Anthropic", "", re.compile(r"anthropic|claude", re.I)),
    ("Mistral AI", "", re.compile(r"mistral|mixtral", re.I)),
    ("Stability AI", "", re.compile(r"stabilityai|stable-diffusion|sdxl", re.I)),
    ("Hugging Face", "", re.compile(r"huggingface|hf-", re.I)),
    ("BAAI", "", re.compile(r"baai|bge", re.I)),
    ("Sentence Transformers", "", re.compile(r"sentence-transformers", re.I)),
]

AI_DEMAND_TICKERS = {"META", "GOOG", "MSFT", "AMZN", "NVDA", "ORCL"}

SPEND_LABEL_FIELDS = {
    "Revenue": "ai_spend_revenue_usd",
    "R&D Expense": "ai_spend_rd_usd",
    "Cost of Revenue": "ai_spend_cost_revenue_usd",
    "Operating Expense": "ai_spend_opex_usd",
    "Backlog / Deferred Revenue": "ai_spend_backlog_deferred_revenue_usd",
}

SPEND_FIELDS = [
    "ai_spend_company",
    "ai_spend_filing_date",
    "ai_spend_period_end",
    "ai_spend_period_days",
    "ai_spend_revenue_usd",
    "ai_spend_rd_usd",
    "ai_spend_capex_flow_usd",
    "ai_capacity_ppe_usd",
    "ai_spend_cost_revenue_usd",
    "ai_spend_opex_usd",
    "ai_spend_backlog_deferred_revenue_usd",
    "ai_spend_proxy_usd",
    "ai_spend_proxy_annualized_usd",
    "ai_spend_proxy_basis",
    "ai_spend_source_url",
    "ai_spend_source_accession",
]


def request_json(url: str):
    delay = 2
    last_error = None
    for attempt in range(4):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body), resp.headers.get("Link", "")
        except (TimeoutError, urllib.error.URLError, urllib.error.HTTPError) as err:
            last_error = err
            if attempt == 3:
                break
            time.sleep(delay)
            delay *= 2
    raise last_error


def empty_spend_fields():
    return {field: "" for field in SPEND_FIELDS}


def to_float(value: str):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_int(value: str):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def annualize(value, period_days: int):
    if value is None or period_days <= 0:
        return None
    return value * 365 / period_days


def spend_candidate_score(row: dict):
    label = row.get("fact_label", "")
    concept = row.get("concept", "")
    period_days = to_int(row.get("period_days"))
    has_duration = 60 <= period_days <= 370
    preferred_capex = label != "Capex / PP&E" or "PaymentsToAcquirePropertyPlantAndEquipment" in concept
    positive = (to_float(row.get("numeric_value")) or 0) > 0
    return (
        row.get("filing_date", ""),
        row.get("period_end", ""),
        int(has_duration),
        int(preferred_capex),
        int(positive),
        period_days,
    )


def is_capex_flow(row: dict):
    return "PaymentsToAcquirePropertyPlantAndEquipment" in row.get("concept", "") and to_int(row.get("period_days")) > 0


def is_ppe_capacity_stock(row: dict):
    concept = row.get("concept", "")
    return (
        "PropertyPlantAndEquipment" in concept
        and "PaymentsToAcquire" not in concept
        and not row.get("period_days")
    )


def load_ai_spend_signals():
    if not AI_DEMAND_FACTS_PATH.exists():
        return {}

    by_ticker_label = {}
    with AI_DEMAND_FACTS_PATH.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            label = row.get("fact_label", "")
            if label not in SPEND_LABEL_FIELDS and label != "Capex / PP&E":
                continue
            if row.get("is_primary_fact") != "True":
                continue
            value = to_float(row.get("numeric_value"))
            if value is None:
                continue
            if label == "Capex / PP&E" and not (is_capex_flow(row) or is_ppe_capacity_stock(row)):
                continue
            key = (row.get("ticker", ""), label)
            if label == "Capex / PP&E":
                key = (row.get("ticker", ""), "Capex Flow" if is_capex_flow(row) else "PPE Capacity")
            current = by_ticker_label.get(key)
            if current is None or spend_candidate_score(row) > spend_candidate_score(current):
                by_ticker_label[key] = row

    signals = {}
    for ticker in sorted({key[0] for key in by_ticker_label}):
        out = empty_spend_fields()
        basis_rows = []
        for label, field in SPEND_LABEL_FIELDS.items():
            row = by_ticker_label.get((ticker, label))
            if not row:
                continue
            out[field] = row.get("numeric_value", "")
            basis_rows.append(row)
        capex_flow_row = by_ticker_label.get((ticker, "Capex Flow"))
        if capex_flow_row:
            out["ai_spend_capex_flow_usd"] = capex_flow_row.get("numeric_value", "")
            basis_rows.append(capex_flow_row)
        ppe_capacity_row = by_ticker_label.get((ticker, "PPE Capacity"))
        if ppe_capacity_row:
            out["ai_capacity_ppe_usd"] = ppe_capacity_row.get("numeric_value", "")
            basis_rows.append(ppe_capacity_row)
        if not basis_rows:
            continue

        latest = max(basis_rows, key=spend_candidate_score)
        out["ai_spend_company"] = latest.get("company", "")
        out["ai_spend_filing_date"] = latest.get("filing_date", "")
        out["ai_spend_period_end"] = latest.get("period_end", "")
        out["ai_spend_period_days"] = latest.get("period_days", "")
        out["ai_spend_source_url"] = latest.get("source_url", "")
        out["ai_spend_source_accession"] = latest.get("accession", "")

        rd_row = by_ticker_label.get((ticker, "R&D Expense"))
        capex_row = by_ticker_label.get((ticker, "Capex Flow"))
        rd_value = to_float(rd_row.get("numeric_value")) if rd_row else None
        capex_value = to_float(capex_row.get("numeric_value")) if capex_row else None
        proxy_parts = [value for value in (rd_value, capex_value) if value is not None]
        if proxy_parts:
            out["ai_spend_proxy_usd"] = round(sum(proxy_parts), 2)
        annualized_parts = [
            annualize(rd_value, to_int(rd_row.get("period_days"))) if rd_row else None,
            annualize(capex_value, to_int(capex_row.get("period_days"))) if capex_row else None,
        ]
        annualized_parts = [value for value in annualized_parts if value is not None]
        if annualized_parts:
            out["ai_spend_proxy_annualized_usd"] = round(sum(annualized_parts), 2)
        if rd_value is not None and capex_value is not None:
            out["ai_spend_proxy_basis"] = "rd_plus_capex_flow_latest_sec_fact_not_ai_only"
        elif rd_value is not None:
            out["ai_spend_proxy_basis"] = "rd_only_latest_sec_fact_not_ai_only"
        elif capex_value is not None:
            out["ai_spend_proxy_basis"] = "capex_flow_only_latest_sec_fact_not_ai_only"
        signals[ticker] = out
    return signals


def next_url_from_link(link_header: str):
    match = re.search(r"<([^>]+)>;\s*rel=\"next\"", link_header or "")
    return match.group(1) if match else None


def tag_value(tags: list[str], prefix: str):
    for tag in tags:
        if tag.startswith(prefix):
            return tag.split(":", 1)[1]
    return ""


def tag_values(tags: list[str], prefix: str, limit: int = 5):
    values = [tag.split(":", 1)[1] for tag in tags if tag.startswith(prefix)]
    return ";".join(values[:limit])


def file_flags(siblings: list[dict]):
    files = [str(item.get("rfilename", "")).lower() for item in siblings]
    joined = " ".join(files)
    return {
        "file_count": len(files),
        "has_safetensors": any(name.endswith(".safetensors") for name in files),
        "has_gguf": any(name.endswith(".gguf") for name in files),
        "has_onnx": any(name.endswith(".onnx") for name in files),
        "has_openvino": "openvino" in joined,
        "has_coreml": "coreml" in joined or ".mlpackage" in joined,
    }


def infer_family(model_id: str, tags: list[str]):
    text = " ".join([model_id, *tags])
    for family, pattern in FAMILY_PATTERNS:
        if pattern.search(text):
            return family
    return "other"


def infer_parameter_hint(model_id: str, tags: list[str]):
    text = " ".join([model_id, *tags])
    match = re.search(r"(?<!\d)(\d+(?:\.\d+)?)\s*[-_ ]?b(?:\b|[-_])", text, re.I)
    if match:
        return f"{match.group(1)}B"
    match = re.search(r"(?<!\d)(\d+(?:\.\d+)?)\s*[-_ ]?m(?:\b|[-_])", text, re.I)
    return f"{match.group(1)}M" if match else ""


def infer_topic(row: dict, flags: dict):
    pipeline = (row.get("pipeline_tag") or "").lower()
    family = row.get("model_family", "")
    tags = row.get("tag_text", "")
    if flags["has_gguf"] or re.search(r"gguf|gptq|awq|exl2|bitsandbytes|quant", tags, re.I):
        return "local_llm_quantization"
    if pipeline in {"text-generation", "text2text-generation", "conversational"} or family in {"llama", "qwen", "mistral", "gemma"}:
        return "open_llm"
    if "sentence" in pipeline or "embedding" in tags:
        return "embeddings_search_rag"
    if "image" in pipeline or family == "stable-diffusion":
        return "image_multimodal"
    if "audio" in pipeline or family == "whisper":
        return "speech_audio"
    return "general_model_usage"


def infer_reddit_theme(topic_bucket: str):
    return {
        "local_llm_quantization": "local LLMs and quantization",
        "open_llm": "open model adoption",
        "embeddings_search_rag": "RAG and embeddings",
        "image_multimodal": "multimodal and image models",
        "speech_audio": "voice and speech models",
        "general_model_usage": "model popularity and deployment",
    }.get(topic_bucket, "model popularity and deployment")


def infer_publisher(model_id: str, author: str, tags: list[str]):
    text = " ".join([model_id, author])
    for publisher, ticker, pattern in PUBLISHER_PATTERNS:
        if pattern.search(text):
            return publisher, ticker
    return author or model_id.split("/", 1)[0], ""


def build_rows():
    rows = []
    spend_signals = load_ai_spend_signals()
    query = urllib.parse.urlencode({
        "sort": "downloads",
        "direction": "-1",
        "limit": PAGE_LIMIT,
        "full": "true",
    })
    url = f"{BASE_URL}?{query}"
    scraped_at = datetime.now(timezone.utc).date().isoformat()

    while url and len(rows) < MAX_ROWS:
        page, link = request_json(url)
        for model in page:
            tags = [str(tag) for tag in model.get("tags") or []]
            flags = file_flags(model.get("siblings") or [])
            model_id = model.get("id") or model.get("modelId") or ""
            author = model.get("author") or model_id.split("/", 1)[0]
            publisher_group, public_company_ticker = infer_publisher(model_id, author, tags)
            row = {
                "rank_by_downloads": len(rows) + 1,
                "model_id": model_id,
                "author": author,
                "publisher_group": publisher_group,
                "public_company_ticker": public_company_ticker,
                "ai_demand_issuer_match": public_company_ticker in AI_DEMAND_TICKERS,
                "synergy_axis": "open_model_adoption",
                "downloads": model.get("downloads") or 0,
                "likes": model.get("likes") or 0,
                "pipeline_tag": model.get("pipeline_tag") or "",
                "library_name": model.get("library_name") or "",
                "license": tag_value(tags, "license:"),
                "model_family": infer_family(model_id, tags),
                "parameter_hint": infer_parameter_hint(model_id, tags),
                "created_at": model.get("createdAt") or "",
                "last_modified": model.get("lastModified") or "",
                "gated": bool(model.get("gated")),
                "private": bool(model.get("private")),
                "tag_count": len(tags),
                "dataset_tags": tag_values(tags, "dataset:"),
                "base_model_tags": tag_values(tags, "base_model:"),
                "arxiv_tags": tag_values(tags, "arxiv:"),
                "language_tags": ";".join([tag for tag in tags if re.fullmatch(r"[a-z]{2,3}", tag)][:5]),
                "tag_text": ";".join(tags[:40]),
                "url": f"https://huggingface.co/{model_id}",
                "scraped_at": scraped_at,
                **flags,
            }
            row.update(spend_signals.get(public_company_ticker, empty_spend_fields()))
            row["topic_bucket"] = infer_topic(row, flags)
            row["reddit_theme"] = infer_reddit_theme(row["topic_bucket"])
            row["is_local_friendly"] = flags["has_gguf"] or flags["has_onnx"] or flags["has_openvino"] or flags["has_coreml"] or bool(re.search(r"gptq|awq|exl2|bitsandbytes|quant", row["tag_text"], re.I))
            row["downloads_per_like"] = round(float(row["downloads"]) / float(row["likes"] or 1), 2)
            rows.append(row)
            if len(rows) >= MAX_ROWS:
                break
        url = next_url_from_link(link)
        time.sleep(0.2)
    return rows


def main():
    rows = build_rows()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "rank_by_downloads",
        "model_id",
        "author",
        "publisher_group",
        "public_company_ticker",
        "ai_demand_issuer_match",
        "synergy_axis",
        "downloads",
        "likes",
        "downloads_per_like",
        "pipeline_tag",
        "library_name",
        "license",
        "model_family",
        "parameter_hint",
        "topic_bucket",
        "reddit_theme",
        "is_local_friendly",
        *SPEND_FIELDS,
        "created_at",
        "last_modified",
        "gated",
        "private",
        "file_count",
        "has_safetensors",
        "has_gguf",
        "has_onnx",
        "has_openvino",
        "has_coreml",
        "tag_count",
        "dataset_tags",
        "base_model_tags",
        "arxiv_tags",
        "language_tags",
        "tag_text",
        "url",
        "scraped_at",
    ]
    with OUT_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows to {OUT_PATH}")


if __name__ == "__main__":
    main()
