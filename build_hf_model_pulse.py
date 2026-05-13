#!/usr/bin/env python3
"""Fetch a public Hugging Face model pulse dataset.

Requires Python 3.9+. Spend proxy columns are directional SEC R&D and
capex-flow signals, not AI-only spend figures.

Output: public/hf_model_pulse.csv
"""

from __future__ import annotations

import csv
import argparse
import json
import os
import re
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


BASE_URL = "https://huggingface.co/api/models"
OUT_PATH = Path("public/hf_model_pulse.csv")
AI_DEMAND_FACTS_PATH = Path("public/ai_demand_facts.csv")
USER_AGENT = os.environ.get(
    "HF_MODEL_PULSE_USER_AGENT",
    "hf-pulse-dataset/1.0 (+https://github.com/protostatis/pyodide-repl)",
)
HF_TOKEN = os.environ.get("HF_TOKEN", "")
MIN_PYTHON_VERSION = (3, 9)
DEFAULT_PAGE_LIMIT = int(os.environ.get("HF_MODEL_PULSE_PAGE_LIMIT", "100"))
DEFAULT_MAX_ROWS = int(os.environ.get("HF_MODEL_PULSE_MAX_ROWS", "10000"))
DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("HF_MODEL_PULSE_TIMEOUT_SECONDS", "300"))
DEFAULT_SLEEP_SECONDS = float(os.environ.get("HF_MODEL_PULSE_SLEEP_SECONDS", "0.5"))
REQUEST_TIMEOUT_SECONDS = int(os.environ.get("HF_MODEL_PULSE_REQUEST_TIMEOUT_SECONDS", "30"))


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

PUBLISHER_ORG_MAP = {
    "meta-llama": ("Meta", "META"),
    "facebook": ("Meta", "META"),
    "google": ("Alphabet / Google", "GOOG"),
    "google-deepmind": ("Alphabet / Google", "GOOG"),
    "deepmind": ("Alphabet / Google", "GOOG"),
    "microsoft": ("Microsoft", "MSFT"),
    "microsoft-research": ("Microsoft", "MSFT"),
    "amazon": ("Amazon", "AMZN"),
    "aws": ("Amazon", "AMZN"),
    "nvidia": ("NVIDIA", "NVDA"),
    "oracle": ("Oracle", "ORCL"),
    "qwen": ("Alibaba / Qwen", "BABA"),
    "alibaba": ("Alibaba / Qwen", "BABA"),
    "openai": ("OpenAI", ""),
    "anthropic": ("Anthropic", ""),
    "mistralai": ("Mistral AI", ""),
    "stabilityai": ("Stability AI", ""),
    "stability-ai": ("Stability AI", ""),
    "huggingface": ("Hugging Face", ""),
    "baai": ("BAAI", ""),
    "sentence-transformers": ("Sentence Transformers", ""),
}

QUANTIZATION_PATTERN = re.compile(r"gguf|gptq|awq|exl2|bitsandbytes|quant", re.I)
PARAMETER_HINT_PATTERN = re.compile(r"(?:^|[/_.\-\s])(\d+(?:\.\d+)?)\s*([bm])(?=$|[/_.\-\s])", re.I)

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

EMPTY_SPEND_FIELDS = {field: "" for field in SPEND_FIELDS}

ACTIVE_ROWS = []
ACTIVE_CHECKPOINT_PATH = None


class PartialDatasetError(RuntimeError):
    def __init__(self, reason: str, checkpoint_path: Path):
        super().__init__(f"{reason}; partial rows saved to {checkpoint_path}")
        self.reason = reason
        self.checkpoint_path = checkpoint_path


def ensure_python_version():
    if sys.version_info < MIN_PYTHON_VERSION:
        required = ".".join(str(part) for part in MIN_PYTHON_VERSION)
        raise SystemExit(f"build_hf_model_pulse.py requires Python {required}+")


def positive_int(value: str):
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return parsed


def non_negative_float(value: str):
    parsed = float(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be 0 or greater")
    return parsed


def parse_args():
    parser = argparse.ArgumentParser(description="Fetch public/hf_model_pulse.csv from the Hugging Face models API.")
    parser.add_argument("--output-path", type=Path, default=OUT_PATH, help="CSV output path.")
    parser.add_argument("--checkpoint-path", type=Path, default=None, help="Partial CSV checkpoint path.")
    parser.add_argument("--max-rows", type=positive_int, default=DEFAULT_MAX_ROWS, help="Maximum models to write.")
    parser.add_argument("--page-limit", type=positive_int, default=DEFAULT_PAGE_LIMIT, help="Hugging Face API page size.")
    parser.add_argument("--timeout-seconds", type=non_negative_float, default=DEFAULT_TIMEOUT_SECONDS, help="Overall scrape timeout; 0 disables it.")
    parser.add_argument("--sleep-seconds", type=non_negative_float, default=DEFAULT_SLEEP_SECONDS, help="Delay between API pages.")
    parser.add_argument("--request-timeout-seconds", type=positive_int, default=REQUEST_TIMEOUT_SECONDS, help="Per-request API timeout.")
    args = parser.parse_args()
    if args.checkpoint_path is None:
        args.checkpoint_path = args.output_path.with_suffix(args.output_path.suffix + ".checkpoint")
    return args


def text_value(value):
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    try:
        return json.dumps(value, sort_keys=True)
    except TypeError:
        return str(value)


def list_value(value):
    return value if isinstance(value, list) else []


def bool_value(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() in {"1", "true", "yes"}
    return bool(value)


def normalized_org(value: str):
    return text_value(value).strip().lower()


def retry_after_seconds(value: str):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def fieldnames():
    return [
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


def write_rows(rows: list[dict], path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames(), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    tmp_path.replace(path)


def save_checkpoint(rows: list[dict], checkpoint_path: Path):
    if rows:
        write_rows(rows, checkpoint_path)


def warn(message: str):
    print(f"warning: {message}", file=sys.stderr)


def save_active_checkpoint(reason: str):
    if ACTIVE_CHECKPOINT_PATH and ACTIVE_ROWS:
        save_checkpoint(ACTIVE_ROWS, ACTIVE_CHECKPOINT_PATH)
        warn(f"{reason}; saved {len(ACTIVE_ROWS)} partial rows to {ACTIVE_CHECKPOINT_PATH}")


def handle_shutdown(signum, _frame):
    name = signal.Signals(signum).name
    save_active_checkpoint(f"received {name}")
    raise SystemExit(128 + signum)


def install_signal_handlers(checkpoint_path: Path):
    global ACTIVE_CHECKPOINT_PATH
    ACTIVE_CHECKPOINT_PATH = checkpoint_path
    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)


def request_json(url: str, timeout_seconds: int):
    delay = 2
    last_error = None
    for attempt in range(4):
        headers = {"User-Agent": USER_AGENT}
        if HF_TOKEN:
            headers["Authorization"] = f"Bearer {HF_TOKEN}"
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body), resp.headers.get("Link", "")
        except urllib.error.HTTPError as err:
            if err.code in {401, 403}:
                raise RuntimeError(f"Hugging Face API returned HTTP {err.code}; request is not authorized") from err
            last_error = err
            if attempt == 3:
                break
            sleep_for = retry_after_seconds(err.headers.get("Retry-After")) if err.code == 429 else None
            if sleep_for is None:
                sleep_for = delay
            if err.code == 429:
                warn(f"Hugging Face API rate limited request; sleeping {sleep_for:g}s before retry")
            time.sleep(sleep_for)
            delay *= 2
        except (TimeoutError, urllib.error.URLError) as err:
            last_error = err
            if attempt == 3:
                break
            time.sleep(delay)
            delay *= 2
    raise last_error


def empty_spend_fields():
    return EMPTY_SPEND_FIELDS.copy()


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
    """Prefer the latest filing and current-period capex/R&D flow facts."""
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
        warn(f"{AI_DEMAND_FACTS_PATH} not found; SEC spend enrichment skipped")
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
    files = [text_value(item.get("rfilename", "")).lower() for item in siblings if isinstance(item, dict)]
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
    match = PARAMETER_HINT_PATTERN.search(text)
    return f"{match.group(1)}{match.group(2).upper()}" if match else ""


def infer_topic(row: dict, flags: dict):
    pipeline = (row.get("pipeline_tag") or "").lower()
    family = row.get("model_family", "")
    tags = row.get("tag_text", "")
    if has_quantization_signal(flags, tags):
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
    namespace = normalized_org(author or model_id.split("/", 1)[0])
    if namespace in PUBLISHER_ORG_MAP:
        return PUBLISHER_ORG_MAP[namespace]
    return author or model_id.split("/", 1)[0], ""


def has_quantization_signal(flags: dict, tag_text: str):
    return bool(flags.get("has_gguf")) or bool(QUANTIZATION_PATTERN.search(tag_text or ""))


def infer_local_friendly(flags: dict, tag_text: str):
    return any(bool(flags.get(key)) for key in ("has_gguf", "has_onnx", "has_openvino", "has_coreml")) or has_quantization_signal(flags, tag_text)


def downloads_per_like(downloads, likes):
    like_count = to_float(likes) or 0
    if like_count <= 0:
        return 0
    return round(float(downloads or 0) / like_count, 2)


def build_rows(max_rows: int, page_limit: int, timeout_seconds: float, sleep_seconds: float, checkpoint_path: Path, request_timeout_seconds: int):
    global ACTIVE_ROWS
    rows = []
    ACTIVE_ROWS = rows
    spend_signals = load_ai_spend_signals()
    query = urllib.parse.urlencode({
        "sort": "downloads",
        "direction": "-1",
        "limit": page_limit,
        "full": "true",
    })
    url = f"{BASE_URL}?{query}"
    scraped_at = datetime.now(timezone.utc).date().isoformat()
    deadline = time.monotonic() + timeout_seconds if timeout_seconds else None

    while url and len(rows) < max_rows:
        if deadline and time.monotonic() >= deadline:
            partial_reason = f"overall timeout reached after {timeout_seconds:g}s"
            save_checkpoint(rows, checkpoint_path)
            warn(f"{partial_reason}; saved {len(rows)} partial rows to {checkpoint_path}")
            raise PartialDatasetError(partial_reason, checkpoint_path)
        try:
            page, link = request_json(url, request_timeout_seconds)
        except Exception as err:
            if not rows:
                raise
            partial_reason = f"persistent Hugging Face API failure: {err}"
            save_checkpoint(rows, checkpoint_path)
            warn(f"stopping after {partial_reason}; saved {len(rows)} partial rows to {checkpoint_path}")
            raise PartialDatasetError(partial_reason, checkpoint_path)
        if not isinstance(page, list):
            raise ValueError("Hugging Face API returned a non-list models page")
        for model in page:
            if not isinstance(model, dict):
                warn("skipping non-object model entry from Hugging Face API")
                continue
            tags = [text_value(tag) for tag in list_value(model.get("tags"))]
            flags = file_flags(list_value(model.get("siblings")))
            model_id = text_value(model.get("id") or model.get("modelId"))
            author = text_value(model.get("author")) or model_id.split("/", 1)[0]
            downloads = to_int(model.get("downloads"))
            likes = to_int(model.get("likes"))
            publisher_group, public_company_ticker = infer_publisher(model_id, author, tags)
            row = {
                "rank_by_downloads": len(rows) + 1,
                "model_id": model_id,
                "author": author,
                "publisher_group": publisher_group,
                "public_company_ticker": public_company_ticker,
                "ai_demand_issuer_match": public_company_ticker in AI_DEMAND_TICKERS,
                "synergy_axis": "open_model_adoption",
                "downloads": downloads,
                "likes": likes,
                "pipeline_tag": text_value(model.get("pipeline_tag")),
                "library_name": text_value(model.get("library_name")),
                "license": tag_value(tags, "license:"),
                "model_family": infer_family(model_id, tags),
                "parameter_hint": infer_parameter_hint(model_id, tags),
                "created_at": text_value(model.get("createdAt")),
                "last_modified": text_value(model.get("lastModified")),
                "gated": bool_value(model.get("gated")),
                "private": bool_value(model.get("private")),
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
            row["is_local_friendly"] = infer_local_friendly(flags, row["tag_text"])
            row["downloads_per_like"] = downloads_per_like(row["downloads"], row["likes"])
            rows.append(row)
            if len(rows) >= max_rows:
                break
        url = next_url_from_link(link)
        save_checkpoint(rows, checkpoint_path)
        if url and sleep_seconds:
            time.sleep(sleep_seconds)
    return rows


def main():
    ensure_python_version()
    args = parse_args()
    install_signal_handlers(args.checkpoint_path)
    try:
        rows = build_rows(
            max_rows=args.max_rows,
            page_limit=args.page_limit,
            timeout_seconds=args.timeout_seconds,
            sleep_seconds=args.sleep_seconds,
            checkpoint_path=args.checkpoint_path,
            request_timeout_seconds=args.request_timeout_seconds,
        )
        write_rows(rows, args.output_path)
        if args.checkpoint_path != args.output_path and args.checkpoint_path.exists():
            args.checkpoint_path.unlink()
        print(f"wrote {len(rows)} rows to {args.output_path}")
    except PartialDatasetError as err:
        raise SystemExit(str(err)) from err
    except Exception as err:
        if ACTIVE_ROWS:
            save_active_checkpoint(f"unexpected error: {err}")
        else:
            warn(f"unexpected error before any rows were scraped: {err}")
        raise


if __name__ == "__main__":
    main()
