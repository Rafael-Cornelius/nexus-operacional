from __future__ import annotations

import argparse
import json
import posixpath
import re
import stat
import struct
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET


CONTENT_TYPES_PART = "[Content_Types].xml"
ROOT_RELS_PART = "_rels/.rels"
WORKBOOK_PART = "xl/workbook.xml"
WORKBOOK_RELS_PART = "xl/_rels/workbook.xml.rels"

CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOCUMENT_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
XLSX_WORKBOOK_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
)

ALLOWED_COMPRESSION_METHODS = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
BLOCKED_PART_PREFIXES = (
    "xl/activex/",
    "xl/embeddings/",
    "xl/externallinks/",
    "xl/macrosheets/",
    "xl/dialogsheets/",
    "xl/querytables/",
)
BLOCKED_PART_NAMES = {
    "xl/connections.xml",
    "xl/attachedtoolbars.bin",
    "xl/vbaproject.bin",
}
BLOCKED_RELATIONSHIP_SUFFIXES = (
    "/activex",
    "/attachedtoolbars",
    "/connections",
    "/control",
    "/customui",
    "/externallink",
    "/oleobject",
    "/package",
    "/querytable",
    "/vbaproject",
)
BLOCKED_CONTENT_TYPE_MARKERS = (
    "macroenabled",
    "vba",
    "activex",
    "oleobject",
)
SAFE_MISSING_EXTERNAL_RELATIONSHIP = "/xlexternallinkpath/xlpathmissing"
WINDOWS_DRIVE = re.compile(r"^[a-zA-Z]:")
DANGEROUS_XML_DECLARATION = re.compile(br"<!\s*(?:DOCTYPE|ENTITY)", re.IGNORECASE)


class WorkbookSecurityError(ValueError):
    """Raised when an uploaded workbook violates the XLSX security policy."""


@dataclass(frozen=True)
class WorkbookLimits:
    max_entries: int = 5_000
    max_uncompressed_bytes: int = 128 * 1024 * 1024
    max_entry_bytes: int = 32 * 1024 * 1024
    max_compression_ratio: float = 200.0
    max_path_depth: int = 20


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _read_xml(zf: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        raw = zf.read(name)
    except (KeyError, RuntimeError, zipfile.BadZipFile) as error:
        raise WorkbookSecurityError(f"Parte XML obrigatoria ilegivel: {name}.") from error

    if DANGEROUS_XML_DECLARATION.search(raw):
        raise WorkbookSecurityError(f"Declaracao XML perigosa encontrada em {name}.")

    try:
        return ET.fromstring(raw)
    except ET.ParseError as error:
        raise WorkbookSecurityError(f"XML invalido em {name}.") from error


def _validate_entry_name(name: str, max_depth: int) -> None:
    if not name or "\x00" in name or "\\" in name:
        raise WorkbookSecurityError("O XLSX contem um caminho interno invalido.")
    if len(name) > 512:
        raise WorkbookSecurityError("O XLSX contem um caminho interno excessivamente longo.")
    if name.startswith("/") or WINDOWS_DRIVE.match(name):
        raise WorkbookSecurityError(f"Caminho absoluto proibido no XLSX: {name[:120]}.")

    trimmed = name[:-1] if name.endswith("/") else name
    path = PurePosixPath(trimmed)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise WorkbookSecurityError(f"Caminho perigoso no XLSX: {name[:120]}.")
    if "//" in trimmed or posixpath.normpath(trimmed) != trimmed:
        raise WorkbookSecurityError(f"Caminho nao canonico no XLSX: {name[:120]}.")
    if len(path.parts) > max_depth:
        raise WorkbookSecurityError(f"Caminho interno profundo demais no XLSX: {name[:120]}.")


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_ISLNK(unix_mode)


def _preflight_entry_count(path: Path, max_entries: int) -> None:
    """Count central-directory records before ZipFile allocates one ZipInfo per member."""
    try:
        with path.open("rb") as source:
            source.seek(0, 2)
            file_size = source.tell()
            tail_size = min(file_size, 65_557)
            source.seek(file_size - tail_size)
            tail = source.read(tail_size)
            search_end = len(tail)
            eocd_index = -1
            eocd: tuple[Any, ...] | None = None
            while search_end:
                candidate = tail.rfind(b"PK\x05\x06", 0, search_end)
                if candidate < 0:
                    break
                if len(tail) - candidate >= 22:
                    candidate_eocd = struct.unpack_from("<4s4H2LH", tail, candidate)
                    if candidate + 22 + candidate_eocd[7] == len(tail):
                        eocd_index = candidate
                        eocd = candidate_eocd
                        break
                search_end = candidate
            if eocd is None:
                raise WorkbookSecurityError("Diretorio central ZIP ausente ou invalido.")
            if eocd[1] != 0 or eocd[2] != 0 or eocd[3] != eocd[4]:
                raise WorkbookSecurityError("Arquivos ZIP divididos em multiplos discos nao sao aceitos.")

            total_entries = eocd[4]
            central_directory_size = eocd[5]
            central_directory_offset = eocd[6]
            if total_entries == 0xFFFF:
                absolute_eocd = file_size - tail_size + eocd_index
                if absolute_eocd < 20:
                    raise WorkbookSecurityError("Metadados ZIP64 invalidos.")
                source.seek(absolute_eocd - 20)
                locator = source.read(20)
                if len(locator) != 20 or locator[:4] != b"PK\x06\x07":
                    raise WorkbookSecurityError("Localizador ZIP64 ausente.")
                zip64_offset = struct.unpack_from("<Q", locator, 8)[0]
                source.seek(zip64_offset)
                zip64_eocd = source.read(56)
                if len(zip64_eocd) != 56 or zip64_eocd[:4] != b"PK\x06\x06":
                    raise WorkbookSecurityError("Diretorio central ZIP64 invalido.")
                total_entries = struct.unpack_from("<Q", zip64_eocd, 32)[0]
                central_directory_size = struct.unpack_from("<Q", zip64_eocd, 40)[0]
                central_directory_offset = struct.unpack_from("<Q", zip64_eocd, 48)[0]

            if central_directory_offset + central_directory_size > file_size:
                raise WorkbookSecurityError("Limites do diretorio central ZIP invalidos.")
            if total_entries > max_entries:
                raise WorkbookSecurityError(
                    f"O XLSX excede o limite de {max_entries} arquivos internos."
                )

            source.seek(central_directory_offset)
            remaining = central_directory_size
            actual_entries = 0
            while remaining:
                header = source.read(46)
                if len(header) != 46 or header[:4] != b"PK\x01\x02":
                    raise WorkbookSecurityError("Registro do diretorio central ZIP invalido.")
                filename_size, extra_size, comment_size = struct.unpack_from("<3H", header, 28)
                record_size = 46 + filename_size + extra_size + comment_size
                if record_size > remaining:
                    raise WorkbookSecurityError("Tamanho de registro ZIP inconsistente.")
                source.seek(record_size - 46, 1)
                remaining -= record_size
                actual_entries += 1
                if actual_entries > max_entries:
                    raise WorkbookSecurityError(
                        f"O XLSX excede o limite de {max_entries} arquivos internos."
                    )
            if actual_entries != total_entries:
                raise WorkbookSecurityError("Contagem do diretorio central ZIP inconsistente.")
    except OSError as error:
        raise WorkbookSecurityError("Nao foi possivel ler o container ZIP.") from error


def _validate_archive_limits(
    zf: zipfile.ZipFile, limits: WorkbookLimits
) -> tuple[int, int, int]:
    infos = zf.infolist()
    if not infos:
        raise WorkbookSecurityError("O arquivo ZIP esta vazio.")
    if len(infos) > limits.max_entries:
        raise WorkbookSecurityError(
            f"O XLSX excede o limite de {limits.max_entries} arquivos internos."
        )

    exact_names: set[str] = set()
    folded_names: set[str] = set()
    total_uncompressed = 0
    total_compressed = 0

    for info in infos:
        _validate_entry_name(info.filename, limits.max_path_depth)
        folded = info.filename.casefold()
        if info.filename in exact_names or folded in folded_names:
            raise WorkbookSecurityError(
                f"Entrada interna duplicada ou ambigua: {info.filename[:120]}."
            )
        exact_names.add(info.filename)
        folded_names.add(folded)

        if info.flag_bits & 0x1:
            raise WorkbookSecurityError("Entradas ZIP criptografadas nao sao aceitas.")
        if _is_symlink(info):
            raise WorkbookSecurityError("Links simbolicos nao sao aceitos dentro do XLSX.")
        if not info.is_dir() and info.compress_type not in ALLOWED_COMPRESSION_METHODS:
            raise WorkbookSecurityError("Metodo de compressao ZIP nao permitido.")
        if info.file_size < 0 or info.compress_size < 0:
            raise WorkbookSecurityError("Tamanho ZIP interno invalido.")
        if info.file_size > limits.max_entry_bytes:
            raise WorkbookSecurityError(
                f"A entrada {info.filename[:120]} excede o limite descompactado individual."
            )

        total_uncompressed += info.file_size
        total_compressed += info.compress_size
        if total_uncompressed > limits.max_uncompressed_bytes:
            raise WorkbookSecurityError(
                "O XLSX excede o limite total descompactado e pode ser um ZIP bomb."
            )

        if info.file_size and not info.compress_size:
            raise WorkbookSecurityError("Razao de compressao ZIP invalida.")
        if info.file_size >= 1024 * 1024:
            ratio = info.file_size / max(info.compress_size, 1)
            if ratio > limits.max_compression_ratio:
                raise WorkbookSecurityError(
                    f"Razao de compressao suspeita em {info.filename[:120]}; possivel ZIP bomb."
                )

    aggregate_ratio = total_uncompressed / max(total_compressed, 1)
    if total_uncompressed >= 1024 * 1024 and aggregate_ratio > limits.max_compression_ratio:
        raise WorkbookSecurityError("Razao de compressao total suspeita; possivel ZIP bomb.")

    # Stream every member so CRC errors and forged size metadata are detected without extraction.
    streamed_total = 0
    for info in infos:
        if info.is_dir():
            continue
        streamed_entry = 0
        try:
            with zf.open(info, "r") as member:
                while chunk := member.read(64 * 1024):
                    streamed_entry += len(chunk)
                    streamed_total += len(chunk)
                    if streamed_entry > limits.max_entry_bytes:
                        raise WorkbookSecurityError(
                            "Uma entrada excedeu o limite durante a descompressao."
                        )
                    if streamed_total > limits.max_uncompressed_bytes:
                        raise WorkbookSecurityError(
                            "O XLSX excedeu o limite durante a descompressao; possivel ZIP bomb."
                        )
        except (RuntimeError, zipfile.BadZipFile, EOFError) as error:
            raise WorkbookSecurityError(
                f"Entrada ZIP corrompida: {info.filename[:120]}."
            ) from error
        if streamed_entry != info.file_size:
            raise WorkbookSecurityError("Metadados de tamanho ZIP inconsistentes.")

    return len(infos), total_compressed, total_uncompressed


def _owner_part_for_relationships(rels_part: str) -> str:
    if rels_part == ROOT_RELS_PART:
        return ""
    marker = "/_rels/"
    if marker not in rels_part or not rels_part.endswith(".rels"):
        raise WorkbookSecurityError(f"Parte de relacionamentos invalida: {rels_part[:120]}.")
    directory, filename = rels_part.split(marker, 1)
    return posixpath.join(directory, filename[: -len(".rels")])


def _resolve_internal_target(owner_part: str, target: str) -> str:
    if not target or "\x00" in target or "\\" in target or len(target) > 2048:
        raise WorkbookSecurityError("Alvo de relacionamento interno invalido.")

    decoded = unquote(target)
    parsed = urlsplit(decoded)
    if parsed.scheme or parsed.netloc or parsed.query:
        raise WorkbookSecurityError("URI externa disfarçada em relacionamento interno.")
    target_path = parsed.path
    if WINDOWS_DRIVE.match(target_path):
        raise WorkbookSecurityError("Caminho de sistema proibido em relacionamento interno.")

    if target_path.startswith("/"):
        combined = target_path.lstrip("/")
    else:
        combined = posixpath.join(posixpath.dirname(owner_part), target_path)
    normalized = posixpath.normpath(combined)
    if normalized in {"", ".", ".."} or normalized.startswith("../"):
        raise WorkbookSecurityError("Relacionamento tenta sair da raiz do pacote XLSX.")
    _validate_entry_name(normalized, 30)
    return normalized


def _safe_missing_external_target(target: str) -> bool:
    if not target or "\x00" in target or "\\" in target or len(target) > 2048:
        return False
    decoded = unquote(target)
    parsed = urlsplit(decoded)
    filename = parsed.path
    return bool(
        not parsed.scheme
        and not parsed.netloc
        and filename
        and "/" not in filename
        and "\\" not in filename
        and "\x00" not in filename
        and not WINDOWS_DRIVE.match(filename)
        and filename not in {".", ".."}
        and ".." not in PurePosixPath(filename).parts
    )


def _relationship_rows(root: ET.Element) -> list[dict[str, str]]:
    if root.tag != f"{{{RELATIONSHIPS_NS}}}Relationships":
        raise WorkbookSecurityError("Namespace de relacionamentos XLSX invalido.")
    rows: list[dict[str, str]] = []
    identifiers: set[str] = set()
    for node in root:
        if _local_name(node.tag) != "Relationship":
            continue
        identifier = node.attrib.get("Id", "")
        if not identifier or identifier in identifiers:
            raise WorkbookSecurityError("Identificador de relacionamento ausente ou duplicado.")
        identifiers.add(identifier)
        rows.append(node.attrib)
    return rows


def _validate_relationships(
    zf: zipfile.ZipFile, names: set[str]
) -> tuple[dict[str, list[dict[str, str]]], int]:
    relationship_sets: dict[str, list[dict[str, str]]] = {}
    ignored_missing_external = 0

    for rels_part in sorted(name for name in names if name.endswith(".rels")):
        owner_part = _owner_part_for_relationships(rels_part)
        rows = _relationship_rows(_read_xml(zf, rels_part))
        relationship_sets[rels_part] = rows
        for row in rows:
            relationship_type = row.get("Type", "").lower()
            target = row.get("Target", "")
            external = row.get("TargetMode", "").strip().lower() == "external"

            if external:
                if (
                    relationship_type.endswith(SAFE_MISSING_EXTERNAL_RELATIONSHIP)
                    and _safe_missing_external_target(target)
                ):
                    # Excel emits this inert marker when a former sibling workbook no longer exists.
                    # It is never dereferenced by the importer and is retained for compatibility.
                    ignored_missing_external += 1
                    continue
                raise WorkbookSecurityError("Relacionamento com objeto externo nao permitido no XLSX.")

            if any(
                relationship_type.endswith(suffix)
                for suffix in BLOCKED_RELATIONSHIP_SUFFIXES
            ):
                raise WorkbookSecurityError("Objeto ativo ou fonte externa nao permitida no XLSX.")

            parsed_target = urlsplit(unquote(target))
            if (
                relationship_type.endswith("/hyperlink")
                and not parsed_target.path
                and parsed_target.fragment
                and len(parsed_target.fragment) <= 1024
            ):
                # Internal sheet/cell anchors do not reference a package member or a network resource.
                continue

            resolved = _resolve_internal_target(owner_part, target)
            if resolved not in names:
                raise WorkbookSecurityError(
                    f"Relacionamento aponta para parte inexistente: {resolved[:120]}."
                )

    return relationship_sets, ignored_missing_external


def _validate_content_types(zf: zipfile.ZipFile, names: set[str]) -> None:
    root = _read_xml(zf, CONTENT_TYPES_PART)
    if root.tag != f"{{{CONTENT_TYPES_NS}}}Types":
        raise WorkbookSecurityError("[Content_Types].xml possui namespace invalido.")

    workbook_type: str | None = None
    for node in root:
        content_type = node.attrib.get("ContentType", "")
        content_type_lower = content_type.lower()
        if any(marker in content_type_lower for marker in BLOCKED_CONTENT_TYPE_MARKERS):
            raise WorkbookSecurityError("Conteudo ativo ou macro detectado no XLSX.")
        if _local_name(node.tag) != "Override":
            continue
        part_name = node.attrib.get("PartName", "").lstrip("/")
        _validate_entry_name(part_name, 30)
        if part_name not in names:
            raise WorkbookSecurityError(
                f"[Content_Types].xml referencia parte inexistente: {part_name[:120]}."
            )
        if part_name == WORKBOOK_PART:
            workbook_type = content_type

    if workbook_type != XLSX_WORKBOOK_CONTENT_TYPE:
        raise WorkbookSecurityError("Tipo do workbook invalido ou habilitado para macros.")


def _validate_workbook_graph(
    zf: zipfile.ZipFile,
    names: set[str],
    relationship_sets: dict[str, list[dict[str, str]]],
) -> int:
    root_relationships = relationship_sets.get(ROOT_RELS_PART, [])
    office_documents = [
        row
        for row in root_relationships
        if row.get("Type", "").lower().endswith("/officedocument")
    ]
    if len(office_documents) != 1:
        raise WorkbookSecurityError("Relacionamento raiz para o workbook ausente ou ambiguo.")
    if office_documents[0].get("TargetMode", "").strip().lower() == "external":
        raise WorkbookSecurityError("O workbook principal nao pode ser externo.")
    if _resolve_internal_target("", office_documents[0].get("Target", "")) != WORKBOOK_PART:
        raise WorkbookSecurityError("O relacionamento raiz nao aponta para xl/workbook.xml.")

    workbook = _read_xml(zf, WORKBOOK_PART)
    if workbook.tag != f"{{{SPREADSHEET_NS}}}workbook":
        raise WorkbookSecurityError("xl/workbook.xml possui estrutura invalida.")
    sheets_node = workbook.find(f"{{{SPREADSHEET_NS}}}sheets")
    if sheets_node is None or not list(sheets_node):
        raise WorkbookSecurityError("O workbook nao possui planilhas.")

    workbook_relationships = {
        row["Id"]: row for row in relationship_sets.get(WORKBOOK_RELS_PART, [])
    }
    for sheet in sheets_node:
        relationship_id = sheet.attrib.get(f"{{{DOCUMENT_REL_NS}}}id", "")
        relationship = workbook_relationships.get(relationship_id)
        if relationship is None:
            raise WorkbookSecurityError("Planilha sem relacionamento interno correspondente.")
        if not relationship.get("Type", "").lower().endswith("/worksheet"):
            raise WorkbookSecurityError("Relacionamento de planilha possui tipo inesperado.")
        target = _resolve_internal_target(WORKBOOK_PART, relationship.get("Target", ""))
        if not target.startswith("xl/worksheets/") or target not in names:
            raise WorkbookSecurityError("Relacionamento de planilha aponta para parte invalida.")

    return len(list(sheets_node))


def validate_workbook(path: Path, limits: WorkbookLimits) -> dict[str, Any]:
    if not path.is_file():
        raise WorkbookSecurityError("Arquivo XLSX nao encontrado.")
    _preflight_entry_count(path, limits.max_entries)
    if not zipfile.is_zipfile(path):
        raise WorkbookSecurityError("O arquivo nao possui um container ZIP valido.")

    try:
        with zipfile.ZipFile(path, "r") as zf:
            entry_count, compressed_bytes, uncompressed_bytes = _validate_archive_limits(
                zf, limits
            )
            names = {info.filename for info in zf.infolist() if not info.is_dir()}
            for required in (
                CONTENT_TYPES_PART,
                ROOT_RELS_PART,
                WORKBOOK_PART,
                WORKBOOK_RELS_PART,
            ):
                if required not in names:
                    raise WorkbookSecurityError(f"Parte obrigatoria ausente: {required}.")

            for name in names:
                lower_name = name.lower()
                if lower_name in BLOCKED_PART_NAMES or lower_name.endswith("/vbaproject.bin"):
                    raise WorkbookSecurityError("Macro ou conteudo executavel detectado no XLSX.")
                if lower_name.startswith(BLOCKED_PART_PREFIXES):
                    raise WorkbookSecurityError("Objeto incorporado ou fonte externa detectada no XLSX.")

            _validate_content_types(zf, names)
            relationship_sets, ignored_missing_external = _validate_relationships(zf, names)
            sheet_count = _validate_workbook_graph(zf, names, relationship_sets)
    except zipfile.BadZipFile as error:
        raise WorkbookSecurityError("O container ZIP do XLSX esta corrompido.") from error

    return {
        "valid": True,
        "entryCount": entry_count,
        "sheetCount": sheet_count,
        "compressedBytes": compressed_bytes,
        "uncompressedBytes": uncompressed_bytes,
        "ignoredMissingExternalRelationships": ignored_missing_external,
    }


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("o limite deve ser positivo")
    return parsed


def _positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 1:
        raise argparse.ArgumentTypeError("a razao deve ser maior que 1")
    return parsed


def main() -> None:
    parser = argparse.ArgumentParser(description="Valida a seguranca estrutural de um XLSX.")
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--max-entries", type=_positive_int, default=5_000)
    parser.add_argument(
        "--max-uncompressed-bytes", type=_positive_int, default=128 * 1024 * 1024
    )
    parser.add_argument("--max-entry-bytes", type=_positive_int, default=32 * 1024 * 1024)
    parser.add_argument("--max-compression-ratio", type=_positive_float, default=200.0)
    parser.add_argument("--max-path-depth", type=_positive_int, default=20)
    args = parser.parse_args()

    limits = WorkbookLimits(
        max_entries=args.max_entries,
        max_uncompressed_bytes=args.max_uncompressed_bytes,
        max_entry_bytes=args.max_entry_bytes,
        max_compression_ratio=args.max_compression_ratio,
        max_path_depth=args.max_path_depth,
    )
    try:
        report = validate_workbook(args.file, limits)
    except (WorkbookSecurityError, OSError, RuntimeError) as error:
        message = str(error) if isinstance(error, WorkbookSecurityError) else "Falha ao ler o XLSX."
        print(json.dumps({"valid": False, "error": message}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from None

    print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
