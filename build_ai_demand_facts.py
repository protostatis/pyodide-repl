#!/usr/bin/env python3
"""Build a source-backed AI demand facts table from SEC XBRL filings.

Output: public/ai_demand_facts.csv
"""

from __future__ import annotations

import csv
import re
from datetime import date
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


SEC_UA = "OpenCode research bot (mailto:research@example.com)"


@dataclass(frozen=True)
class Filing:
    company: str
    ticker: str
    filing_date: str
    accession: str
    source_url: str


FILINGS = [
    Filing(
        company="Meta Platforms, Inc.",
        ticker="META",
        filing_date="2026-04-30",
        accession="0001628280-26-028526",
        source_url="https://www.sec.gov/Archives/edgar/data/1326801/000162828026028526/meta-20260331_htm.xml",
    ),
    Filing(
        company="Microsoft Corporation",
        ticker="MSFT",
        filing_date="2026-04-29",
        accession="0001193125-26-191507",
        source_url="https://www.sec.gov/Archives/edgar/data/789019/000119312526191507/msft-20260331_htm.xml",
    ),
    Filing(
        company="Alphabet Inc.",
        ticker="GOOG",
        filing_date="2026-04-30",
        accession="0001652044-26-000048",
        source_url="https://www.sec.gov/Archives/edgar/data/1652044/000165204426000048/goog-20260331_htm.xml",
    ),
    Filing(
        company="Amazon.com, Inc.",
        ticker="AMZN",
        filing_date="2026-04-30",
        accession="0001018724-26-000014",
        source_url="https://www.sec.gov/Archives/edgar/data/1018724/000101872426000014/amzn-20260331_htm.xml",
    ),
    Filing(
        company="Oracle Corporation",
        ticker="ORCL",
        filing_date="2026-03-11",
        accession="0001193125-26-101045",
        source_url="https://www.sec.gov/Archives/edgar/data/1341439/000119312526101045/orcl-20260228_htm.xml",
    ),
    Filing(
        company="Broadcom Inc.",
        ticker="AVGO",
        filing_date="2026-03-11",
        accession="0001730168-26-000016",
        source_url="https://www.sec.gov/Archives/edgar/data/1730168/000173016826000016/avgo-20260201_htm.xml",
    ),
    Filing(
        company="Vertiv Holdings Co",
        ticker="VRT",
        filing_date="2026-04-22",
        accession="0001628280-26-026556",
        source_url="https://www.sec.gov/Archives/edgar/data/1674101/000162828026026556/vrt-20260331_htm.xml",
    ),
    Filing(
        company="Micron Technology, Inc.",
        ticker="MU",
        filing_date="2026-03-19",
        accession="0000723125-26-000006",
        source_url="https://www.sec.gov/Archives/edgar/data/723125/000072312526000006/mu-20260226_htm.xml",
    ),
    Filing(
        company="NVIDIA Corporation",
        ticker="NVDA",
        filing_date="2025-11-19",
        accession="0001045810-25-000230",
        source_url="https://www.sec.gov/Archives/edgar/data/1045810/000104581025000230/nvda-20251026_htm.xml",
    ),
    Filing(
        company="Oracle Corporation",
        ticker="ORCL",
        filing_date="2025-09-10",
        accession="0001193125-25-200095",
        source_url="https://www.sec.gov/Archives/edgar/data/1341439/000119312525200095/orcl-20250831_htm.xml",
    ),
    Filing(
        company="Broadcom Inc.",
        ticker="AVGO",
        filing_date="2025-09-10",
        accession="0001730168-25-000098",
        source_url="https://www.sec.gov/Archives/edgar/data/1730168/000173016825000098/avgo-20250803_htm.xml",
    ),
    Filing(
        company="Vertiv Holdings Co",
        ticker="VRT",
        filing_date="2025-04-23",
        accession="0001628280-25-019372",
        source_url="https://www.sec.gov/Archives/edgar/data/1674101/000162828025019372/vrt-20250331_htm.xml",
    ),
    Filing(
        company="Micron Technology, Inc.",
        ticker="MU",
        filing_date="2025-06-26",
        accession="0000723125-25-000021",
        source_url="https://www.sec.gov/Archives/edgar/data/723125/000072312525000021/mu-20250529_htm.xml",
    ),
    Filing(
        company="NVIDIA Corporation",
        ticker="NVDA",
        filing_date="2025-08-27",
        accession="0001045810-25-000209",
        source_url="https://www.sec.gov/Archives/edgar/data/1045810/000104581025000209/nvda-20250727_htm.xml",
    ),
]


NS = {
    "xbrli": "http://www.xbrl.org/2003/instance",
    "xbrldi": "http://xbrl.org/2006/xbrldi",
}


FACT_RULES = [
    (re.compile(r"^RevenueFromContractWithCustomerExcludingAssessedTax$|^Revenues?$"), "demand", "Revenue"),
    (re.compile(r"CostOfRevenue|CostOfGoodsAndServicesSold"), "demand", "Cost of Revenue"),
    (re.compile(r"OperatingIncomeLoss"), "profitability", "Operating Income"),
    (re.compile(r"NetIncomeLoss"), "profitability", "Net Income"),
    (re.compile(r"ResearchAndDevelopmentExpense"), "demand", "R&D Expense"),
    (re.compile(r"GeneralAndAdministrativeExpense|SellingAndMarketingExpense|SellingGeneralAndAdministrativeExpense|OperatingExpenses|CostsAndExpenses"), "opex", "Operating Expense"),
    (re.compile(r"AllocatedShareBasedCompensationExpense|ShareBasedCompensation|StockIssuedDuringPeriodValueShareBasedCompensation|AdjustmentsRelatedToTaxWithholdingForShareBasedCompensation|PaymentsRelatedToTaxWithholdingForShareBasedCompensation"), "demand", "Share-based Compensation"),
    (re.compile(r"PaymentsToAcquirePropertyPlantAndEquipment|PropertyPlantAndEquipmentNet|PropertyPlantAndEquipmentGross|PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAsset|OperatingLeaseRightOfUseAsset"), "capacity", "Capex / PP&E"),
    (re.compile(r"CashAndCashEquivalents|CashEquivalentsAtCarryingValue|CashCashEquivalents"), "balance_sheet", "Cash and Equivalents"),
    (re.compile(r"LongTermDebt|DebtInstrumentCarryingAmount|DebtInstrumentFaceAmount|DebtInstrumentFairValue|RepaymentsOfDebt"), "balance_sheet", "Debt"),
    (re.compile(r"RevenueRemainingPerformanceObligation|ContractWithCustomerLiability|IncreaseDecreaseInContractWithCustomerLiability"), "demand", "Backlog / Deferred Revenue"),
    (re.compile(r"NetCashProvidedByUsedInOperatingActivities|NetCashProvidedByUsedInInvestingActivities|NetCashProvidedByUsedInFinancingActivities"), "cash_flow", "Cash Flow"),
]


def local_name(tag: str) -> str:
    if tag.startswith("{"):
        return tag.rsplit("}", 1)[1]
    return tag


def namespace_uri(tag: str) -> str:
    if tag.startswith("{"):
        return tag[1:].split("}", 1)[0]
    return ""


def split_qname(tag: str) -> tuple[str, str]:
    return namespace_uri(tag), local_name(tag)


def to_number(raw: str):
    text = raw.strip().replace(",", "")
    neg = text.startswith("(") and text.endswith(")")
    if neg:
        text = text[1:-1]
    if text.endswith("%"):
        text = text[:-1]
    if text in {"", "-", "--"}:
        return None
    try:
        value = float(text)
        return -value if neg else value
    except ValueError:
        return None


def period_days(start: str, end: str):
    if not start or not end:
        return None
    try:
        start_date = date.fromisoformat(start)
        end_date = date.fromisoformat(end)
    except ValueError:
        return None
    return (end_date - start_date).days


def normalize_fact(concept: str):
    for pattern, group, label in FACT_RULES:
        if pattern.search(concept):
            return group, label
    return "other", concept


def parse_contexts(root: ET.Element):
    contexts = {}
    for ctx in root.findall(".//xbrli:context", NS):
        ctx_id = ctx.attrib.get("id", "")
        period = ctx.find("xbrli:period", NS)
        start = period.findtext("xbrli:startDate", default="", namespaces=NS) if period is not None else ""
        end = period.findtext("xbrli:endDate", default="", namespaces=NS) if period is not None else ""
        instant = period.findtext("xbrli:instant", default="", namespaces=NS) if period is not None else ""

        dims = []
        for member in ctx.findall(".//xbrldi:explicitMember", NS):
            dim = member.attrib.get("dimension", "")
            dims.append(f"{dim}={member.text or ''}")
        for member in ctx.findall(".//xbrldi:typedMember", NS):
            dim = member.attrib.get("dimension", "")
            dims.append(f"{dim}={''.join(member.itertext()).strip()}")

        contexts[ctx_id] = {
            "start": start,
            "end": end,
            "instant": instant,
            "type": "instant" if instant else "duration" if start or end else "unknown",
            "dimensions": ";".join(sorted(filter(None, dims))),
        }
    return contexts


def fetch_xml(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": SEC_UA, "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def extract_rows(filing: Filing):
    root = ET.fromstring(fetch_xml(filing.source_url))
    contexts = parse_contexts(root)
    rows = []
    concept_counts = Counter()

    for elem in root.iter():
        unit_ref = elem.attrib.get("unitRef")
        ctx_ref = elem.attrib.get("contextRef")
        raw = (elem.text or "").strip()
        if not unit_ref or not ctx_ref or not raw:
            continue

        num = to_number(raw)
        if num is None:
            continue

        ctx = contexts.get(ctx_ref, {})
        ns, concept = split_qname(elem.tag)
        concept_counts[concept] += 1
        fact_group, fact_label = normalize_fact(concept)
        dimensions = ctx.get("dimensions", "")

        rows.append({
            "company": filing.company,
            "ticker": filing.ticker,
            "filing_date": filing.filing_date,
            "accession": filing.accession,
            "source_url": filing.source_url,
            "concept": concept,
            "fact_label": fact_label,
            "fact_group": fact_group,
            "namespace": ns,
            "unit": unit_ref,
            "raw_value": raw,
            "numeric_value": num,
            "context_ref": ctx_ref,
            "context_type": ctx.get("type", "unknown"),
            "period_start": ctx.get("start", ""),
            "period_end": ctx.get("end", ctx.get("instant", "")),
            "period_days": period_days(ctx.get("start", ""), ctx.get("end", ctx.get("instant", ""))),
            "dimensions": dimensions,
            "dimension_count": len([part for part in dimensions.split(";") if part]),
            "is_primary_fact": not dimensions and ctx.get("type", "unknown") in {"instant", "duration"},
        })

    return rows, concept_counts


def main():
    all_rows = []
    concept_totals = Counter()

    for filing in FILINGS:
        rows, counts = extract_rows(filing)
        all_rows.extend(rows)
        concept_totals.update(counts)
        print(f"{filing.ticker}: {len(rows)} rows")

    out_path = Path("public/ai_demand_facts.csv")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "company",
        "ticker",
        "filing_date",
        "accession",
        "source_url",
        "concept",
        "fact_label",
        "fact_group",
        "namespace",
        "unit",
        "raw_value",
        "numeric_value",
        "context_ref",
        "context_type",
        "period_start",
        "period_end",
        "period_days",
        "dimensions",
        "dimension_count",
        "is_primary_fact",
    ]

    with out_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"wrote {len(all_rows)} rows to {out_path}")
    print("top concepts:")
    for concept, count in concept_totals.most_common(15):
        print(f"  {concept}: {count}")


if __name__ == "__main__":
    main()
