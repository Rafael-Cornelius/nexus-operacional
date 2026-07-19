from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import zipfile
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

ERROR_VALUES = ["#N/A", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#NULL!"]
MONTH_NAMES = {
    "JANEIRO": 1,
    "FEVEREIRO": 2,
    "MARCO": 3,
    "ABRIL": 4,
    "MAIO": 5,
    "JUNHO": 6,
    "JULHO": 7,
    "AGOSTO": 8,
    "SETEMBRO": 9,
    "OUTUBRO": 10,
    "NOVEMBRO": 11,
    "DEZEMBRO": 12,
}
NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def q(ns: str, tag: str) -> str:
    return f"{{{NS[ns]}}}{tag}"


def read_xml(zf: zipfile.ZipFile, name: str) -> ET.Element:
    return ET.fromstring(zf.read(name))


def rel_target(base: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), target)).lstrip("/")


def rels_for(zf: zipfile.ZipFile, part: str) -> dict[str, str]:
    rel_path = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if rel_path not in zf.namelist():
        return {}
    return {
        node.attrib["Id"]: rel_target(part, node.attrib["Target"])
        for node in read_xml(zf, rel_path)
        if node.attrib.get("TargetMode") != "External"
    }


def shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = read_xml(zf, "xl/sharedStrings.xml")
    return ["".join(node.itertext()) for node in root.findall(q("m", "si"))]


def cell_value(shared: list[str], cell: ET.Element) -> str | None:
    typ = cell.attrib.get("t")
    inline = cell.find(q("m", "is"))
    value = cell.find(q("m", "v"))
    if inline is not None:
        return "".join(inline.itertext())
    if value is None:
        return None
    raw = "".join(value.itertext())
    if typ == "s" and raw.isdigit() and int(raw) < len(shared):
        return shared[int(raw)]
    return raw


def column_index(cell_ref: str) -> int:
    match = re.match(r"([A-Z]+)", cell_ref)
    if not match:
        return 0
    value = 0
    for char in match.group(1):
        value = value * 26 + ord(char) - 64
    return value


def row_index(cell_ref: str) -> int:
    match = re.search(r"(\d+)", cell_ref)
    return int(match.group(1)) if match else 0


def column_name(index: int) -> str:
    name = ""
    current = index
    while current > 0:
        current, remainder = divmod(current - 1, 26)
        name = chr(65 + remainder) + name
    return name


def cell_ref(row: int, column: int) -> str:
    return f"{column_name(column)}{row}"


def read_sheet_rows(zf: zipfile.ZipFile, shared: list[str], sheet_path: str) -> dict[int, dict[int, str | None]]:
    root = read_xml(zf, sheet_path)
    rows: dict[int, dict[int, str | None]] = {}
    for cell in root.findall(f".//{q('m', 'c')}"):
        ref = cell.attrib.get("r", "A1")
        row = row_index(ref)
        column = column_index(ref)
        rows.setdefault(row, {})[column] = cell_value(shared, cell)
    return rows


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_code(value: Any) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    if re.fullmatch(r"\d+(\.0+)?", text):
        return text.split(".")[0]
    return text


def as_number(value: Any) -> float | None:
    text = clean_text(value)
    if not text or text in ERROR_VALUES:
        return None
    normalized = text.replace(".", "").replace(",", ".") if "," in text else text
    try:
        number = float(normalized)
    except ValueError:
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def as_int(value: Any) -> int | None:
    number = as_number(value)
    if number is None:
        return None
    return int(round(number))


def excel_date(value: Any) -> str | None:
    number = as_number(value)
    if number is not None and number > 20_000:
        return (datetime(1899, 12, 30) + timedelta(days=number)).date().isoformat()
    text = clean_text(value)
    if not text:
        return None
    for pattern in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            pass
    return None


def excel_time(value: Any) -> str | None:
    number = as_number(value)
    if number is not None and 0 <= number < 1:
        seconds = int(round(number * 24 * 60 * 60)) % (24 * 60 * 60)
        return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:00"
    text = clean_text(value)
    if text and re.fullmatch(r"\d{1,2}:\d{2}(:\d{2})?", text):
        return text if len(text.split(":")) == 3 else f"{text}:00"
    return None


def import_error(sheet: str, row: int, column: int, field: str, message: str, raw: Any = None) -> dict[str, Any]:
    return {
        "sheetName": sheet,
        "cell": cell_ref(row, column),
        "rowNumber": row,
        "field": field,
        "message": message,
        "rawValue": clean_text(raw),
    }


def infer_sector(name: str) -> str:
    p2_keywords = [
        "BOLO",
        "CHURROS",
        "COOKIE",
        "COOKIES",
        "TORTA",
        "CROISSANT",
        "FOLHADO",
        "CAROLINA",
        "ECLAIR",
        "ÉCLAIR",
    ]
    upper = name.upper()
    return "P2" if any(keyword in upper for keyword in p2_keywords) else "P1"


def completeness_score(row: dict[str, Any]) -> int:
    return sum(1 for value in row.values() if value not in (None, ""))


def extract_legacy_products(
    zf: zipfile.ZipFile,
    shared: list[str],
    sheet_paths: dict[str, str],
) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    products_by_code: dict[str, dict[str, Any]] = {}
    weights_by_code: dict[str, dict[str, Any]] = {}
    duplicate_product_codes: list[str] = []
    duplicate_weight_codes: list[str] = []

    product_sheet = "Pacotes-caixas"
    if product_sheet in sheet_paths:
        rows = read_sheet_rows(zf, shared, sheet_paths[product_sheet])
        for row_number in sorted(rows):
            if row_number == 1:
                continue
            row = rows[row_number]
            code = normalize_code(row.get(1))
            name = clean_text(row.get(2))
            if not code and not name:
                continue
            if not code or not name:
                errors.append(import_error(product_sheet, row_number, 1, "code", "Product row without code or name.", row.get(1)))
                continue

            candidate = {
                "code": code,
                "name": name,
                "packageWeightKg": as_number(row.get(3)),
                "boxWeightKg": as_number(row.get(4)),
                "packagesPerBox": as_int(row.get(5)),
                "massWeightKg": as_number(row.get(6)),
                "sourceRows": [{"sheet": product_sheet, "row": row_number}],
            }
            if code in products_by_code:
                duplicate_product_codes.append(code)
                errors.append(import_error(product_sheet, row_number, 1, "code", f"Duplicate product code {code}.", row.get(1)))
                if completeness_score(candidate) > completeness_score(products_by_code[code]):
                    products_by_code[code] = candidate
            else:
                products_by_code[code] = candidate

    weight_sheet = "Banco de Dados Pesagen"
    if weight_sheet in sheet_paths:
        rows = read_sheet_rows(zf, shared, sheet_paths[weight_sheet])
        for row_number in sorted(rows):
            if row_number < 8:
                continue
            row = rows[row_number]
            code = normalize_code(row.get(4))
            if not code:
                continue
            candidate = {
                "code": code,
                "massWeightKg": as_number(row.get(5)),
                "boxWeightKg": as_number(row.get(6)),
                "targetPackageWeightG": as_number(row.get(7)),
                "sourceRows": [{"sheet": weight_sheet, "row": row_number}],
            }
            if code in weights_by_code:
                duplicate_weight_codes.append(code)
                errors.append(import_error(weight_sheet, row_number, 4, "code", f"Duplicate weighing code {code}.", row.get(4)))
                if completeness_score(candidate) > completeness_score(weights_by_code[code]):
                    weights_by_code[code] = candidate
            else:
                weights_by_code[code] = candidate

    all_codes = list(dict.fromkeys([*products_by_code.keys(), *weights_by_code.keys()]))
    normalized_products = []
    for code in all_codes:
        product = products_by_code.get(code, {})
        weight = weights_by_code.get(code, {})
        name = product.get("name") or f"Produto legado {code}"
        package_weight = product.get("packageWeightKg")
        target_package_weight = weight.get("targetPackageWeightG") or (package_weight * 1000 if package_weight else None)
        box_weight = product.get("boxWeightKg") or weight.get("boxWeightKg")
        packages_per_box = product.get("packagesPerBox")
        if not packages_per_box and package_weight and box_weight:
            packages_per_box = max(int(round(box_weight / package_weight)), 1)

        if not box_weight:
            errors.append(import_error(product_sheet, product.get("sourceRows", [{"row": 0}])[0]["row"], 4, "boxWeightKg", f"Product {code} without box weight."))
        if not packages_per_box:
            errors.append(import_error(product_sheet, product.get("sourceRows", [{"row": 0}])[0]["row"], 5, "packagesPerBox", f"Product {code} without packages per box."))
        if not target_package_weight:
            errors.append(import_error(weight_sheet, weight.get("sourceRows", [{"row": 0}])[0]["row"], 7, "targetPackageWeightG", f"Product {code} without target package weight."))

        normalized_products.append(
            {
                "code": code,
                "name": name,
                "defaultSector": infer_sector(name),
                "packageWeightKg": package_weight or (target_package_weight / 1000 if target_package_weight else 0),
                "boxWeightKg": box_weight or 0,
                "packagesPerBox": packages_per_box or 1,
                "massWeightKg": product.get("massWeightKg") or weight.get("massWeightKg") or 0,
                "targetPackageWeightG": target_package_weight or 1,
                "unit": "kg",
                "overweightTolerancePercent": 0.02,
                "formula": "BOX_WEIGHT",
                "active": True,
                "source": {
                    "productRows": product.get("sourceRows", []),
                    "weightRows": weight.get("sourceRows", []),
                },
            }
        )

    return {
        "products": normalized_products,
        "productCount": len(normalized_products),
        "duplicateProductCodes": sorted(set(duplicate_product_codes)),
        "duplicateWeightCodes": sorted(set(duplicate_weight_codes)),
        "importErrors": errors,
        "importErrorCount": len(errors),
    }


def expected_period_from_filename(path: Path) -> tuple[str, str] | None:
    normalized = path.stem.upper().replace("Ç", "C").replace("Ã", "A")
    months = re.findall("|".join(MONTH_NAMES), normalized)
    year_match = re.search(r"\b(20\d{2})\b", normalized)
    if len(months) < 2 or not year_match:
        return None
    year = int(year_match.group(1))
    first_month, last_month = sorted((MONTH_NAMES[months[0]], MONTH_NAMES[months[1]]))
    starts_on = datetime(year, first_month, 1)
    next_month = datetime(year + (last_month == 12), (last_month % 12) + 1, 1)
    ends_on = next_month - timedelta(days=1)
    return starts_on.date().isoformat(), ends_on.date().isoformat()


def extract_operational_data(
    zf: zipfile.ZipFile,
    shared: list[str],
    sheet_paths: dict[str, str],
    expected_period: tuple[str, str] | None = None,
) -> dict[str, Any]:
    errors: list[dict[str, Any]] = []
    production_entries: list[dict[str, Any]] = []
    loss_entries: list[dict[str, Any]] = []
    downtime_entries: list[dict[str, Any]] = []

    def date_is_allowed(sheet: str, row_number: int, column: int, value: str) -> bool:
        if not expected_period or expected_period[0] <= value <= expected_period[1]:
            return True
        errors.append(
            import_error(
                sheet,
                row_number,
                column,
                "date",
                f"Date {value} is outside the period declared by the workbook name ({expected_period[0]} to {expected_period[1]}).",
                value,
            )
        )
        return False

    def add_production(sheet: str, sector: str, columns: dict[str, int]) -> None:
        if sheet not in sheet_paths:
            return
        for row_number, row in read_sheet_rows(zf, shared, sheet_paths[sheet]).items():
            week_number = as_int(row.get(columns["week"]))
            date = excel_date(row.get(columns["date"]))
            product_code = normalize_code(row.get(columns["product"]))
            if not week_number or not date or not product_code:
                continue
            if not date_is_allowed(sheet, row_number, columns["date"], date):
                continue
            planned = as_number(row.get(columns["planned"]))
            realized = as_number(row.get(columns["realized"]))
            packed_boxes = as_number(row.get(columns["boxes"]))
            if planned is None or realized is None or packed_boxes is None:
                errors.append(import_error(sheet, row_number, columns["boxes"], "production", "Production row without planned, realized batches or packed boxes."))
                continue
            production_entries.append({
                "sheetName": sheet,
                "rowNumber": row_number,
                "sector": sector,
                "legacyWeekNumber": week_number,
                "date": date,
                "productCode": product_code,
                "productionOrder": clean_text(row.get(columns["op"])) or f"LEG-{sheet}-{row_number}",
                "plannedBatches": planned,
                "realizedBatches": realized,
                "usedReworkKg": as_number(row.get(columns.get("usedRework", 0))) or 0,
                "packedBoxes": packed_boxes,
                "weighingLossKg": as_number(row.get(columns["weighingLoss"])) or 0,
                "generatedReworkKg": as_number(row.get(columns["generatedRework"])) or 0,
                "averagePackageWeightG": as_number(row.get(columns["averageWeight"])),
                "notes": clean_text(row.get(columns["notes"])),
                "pricePerKg": as_number(row.get(columns["pricePerKg"])) or 0,
            })

    add_production("Plan x Real (P1)", "P1", {
        "week": 2, "date": 3, "product": 4, "op": 5, "planned": 6, "realized": 7, "usedRework": 8,
        "boxes": 9, "weighingLoss": 11, "generatedRework": 12, "averageWeight": 18, "notes": 22, "pricePerKg": 23,
    })
    add_production("Plan x Real (P2)", "P2", {
        "week": 2, "date": 3, "product": 4, "op": 5, "planned": 6, "realized": 7,
        "boxes": 8, "weighingLoss": 10, "generatedRework": 11, "averageWeight": 17, "notes": 21, "pricePerKg": 22,
    })

    production_orders = {entry["productionOrder"] for entry in production_entries}
    filtered_production_entries: list[dict[str, Any]] = []
    for entry in production_entries:
        planned = entry["plannedBatches"]
        planned_as_code = str(int(planned)) if float(planned).is_integer() else ""
        if planned >= 10000 and planned_as_code in production_orders and planned_as_code != entry["productionOrder"]:
            errors.append(
                import_error(
                    entry["sheetName"],
                    entry["rowNumber"],
                    6,
                    "plannedBatches",
                    f"Planned batches value {planned_as_code} duplicates another production order and requires review.",
                    planned_as_code,
                )
            )
            continue
        filtered_production_entries.append(entry)
    production_entries = filtered_production_entries

    loss_sheet = "CONTROLE DE PERDAS"
    if loss_sheet in sheet_paths:
        for row_number, row in read_sheet_rows(zf, shared, sheet_paths[loss_sheet]).items():
            date = excel_date(row.get(2))
            quantity = as_number(row.get(4))
            machine = clean_text(row.get(3))
            if not date or quantity is None or not machine:
                continue
            if not date_is_allowed(loss_sheet, row_number, 2, date):
                continue
            loss_entries.append({
                "sheetName": loss_sheet,
                "rowNumber": row_number,
                "date": date,
                "quantityKg": quantity,
                "legacyLine": machine,
                "lossType": "PACKAGING",
                "notes": f"Importado do controle de perdas; máquina: {machine}",
            })

    downtime_sheet = "relatorios de paradas"
    if downtime_sheet in sheet_paths:
        for row_number, row in read_sheet_rows(zf, shared, sheet_paths[downtime_sheet]).items():
            date = excel_date(row.get(1))
            production_start, production_end = excel_time(row.get(2)), excel_time(row.get(3))
            downtime_start, downtime_end = excel_time(row.get(4)), excel_time(row.get(5))
            reason, legacy_line = clean_text(row.get(6)), clean_text(row.get(7))
            if not all([date, production_start, production_end, downtime_start, downtime_end, reason, legacy_line]):
                continue
            if not date_is_allowed(downtime_sheet, row_number, 1, date):
                continue
            downtime_entries.append({
                "sheetName": downtime_sheet,
                "rowNumber": row_number,
                "date": date,
                "productionStart": production_start,
                "productionEnd": production_end,
                "downtimeStart": downtime_start,
                "downtimeEnd": downtime_end,
                "reason": reason,
                "legacyLine": legacy_line,
                "legacyWeekNumber": as_int(row.get(8)),
            })

    return {
        "productionEntries": production_entries,
        "productionEntryCount": len(production_entries),
        "lossEntries": loss_entries,
        "lossEntryCount": len(loss_entries),
        "downtimeEntries": downtime_entries,
        "downtimeEntryCount": len(downtime_entries),
        "operationalImportErrors": errors,
    }


def inspect_workbook(path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        shared = shared_strings(zf)
        workbook = read_xml(zf, "xl/workbook.xml")
        workbook_rels = rels_for(zf, "xl/workbook.xml")
        sheets = []
        sheet_paths: dict[str, str] = {}
        total_formulas = 0
        errors = Counter()
        tables = [name for name in names if name.startswith("xl/tables/") and name.endswith(".xml")]
        charts = [name for name in names if name.startswith("xl/charts/chart") and name.endswith(".xml")]

        sheets_node = workbook.find(q("m", "sheets"))
        if sheets_node is None:
            return {
                "file": str(path),
                "sheets": [],
                "sheetCount": 0,
                "formulaCount": 0,
                "tableCount": len(tables),
                "chartCount": len(charts),
                "errors": {},
            }

        for sheet in sheets_node:
            name = sheet.attrib["name"]
            rel_id = sheet.attrib[q("r", "id")]
            sheet_path = workbook_rels[rel_id]
            sheet_paths[name] = sheet_path
            root = read_xml(zf, sheet_path)
            formulas = 0
            non_empty = 0
            sheet_errors = Counter()
            for cell in root.findall(f".//{q('m', 'c')}"):
                formula = cell.find(q("m", "f"))
                value = cell_value(shared, cell)
                if formula is not None:
                    formulas += 1
                    total_formulas += 1
                if value not in (None, "") or formula is not None:
                    non_empty += 1
                if cell.attrib.get("t") == "e" or value in ERROR_VALUES:
                    sheet_errors[str(value)] += 1
                    errors[str(value)] += 1
            sheets.append(
                {
                    "name": name,
                    "state": sheet.attrib.get("state", "visible"),
                    "dimension": (root.find(q("m", "dimension")).attrib.get("ref") if root.find(q("m", "dimension")) is not None else None),
                    "formulas": formulas,
                    "nonEmpty": non_empty,
                    "errors": dict(sheet_errors),
                }
            )

        return {
            "file": str(path),
            "sheets": sheets,
            "sheetCount": len(sheets),
            "formulaCount": total_formulas,
            "tableCount": len(tables),
            "chartCount": len(charts),
            "errors": dict(errors),
            "legacyData": {
                **extract_legacy_products(zf, shared, sheet_paths),
                **extract_operational_data(zf, shared, sheet_paths, expected_period_from_filename(path)),
            },
        }


def find_default_workbook() -> Path:
    env_path = os.environ.get("LEGACY_EXCEL_PATH")
    if env_path and Path(env_path).exists():
        return Path(env_path)
    downloads = Path.home() / "Downloads"
    matches = sorted(downloads.glob("*MAIO*2026*.xlsx"), key=lambda item: item.stat().st_mtime, reverse=True)
    for match in matches:
        if zipfile.is_zipfile(match):
            return match
    raise FileNotFoundError("Legacy workbook not found. Set LEGACY_EXCEL_PATH or pass --file.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect and import the legacy NEXUS Excel workbook safely.")
    parser.add_argument("--file", type=Path, default=None)
    parser.add_argument("--report", type=Path, default=None)
    args = parser.parse_args()

    path = args.file or find_default_workbook()
    report = inspect_workbook(path)
    if args.report:
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
