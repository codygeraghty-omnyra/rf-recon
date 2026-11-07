"""
One Intake (Cody 11/5: "dump all forms/files/pdfs/plans/contacts/folder/etc in one location and have it auto scan them to make
sure they're good, then auto distribute them to their place", "for the whole RF Recon app").

Everything dropped comes through here, from any tab: files, folders, zips and old emails. Each item is hashed, scanned, recognised,
matched to a job, then filed, held for a press, or put on the "needs a look" pile. What happens to each kind:

  file   a plain document files itself into the job's Files. It only ever fills an empty spot.
  fill   a firm-wide list (contacts): new rows, and blanks on rows already kept. Nothing written over.
  press  readings, prices and anything else that changes a job's numbers wait for one press. They never go in by themselves.
  own    install kits, field packs, whole jobs and the FCC's files keep their own box: named here, and sent there.

The refusal rules: nothing that runs code is ever saved into a job's Files, because job Files are served to open in the browser
(app.py das_route, "file"), where an HTML or SVG file runs as the signed-in person. Refused items stay here under a number, with no
file type, and no route serves them. _safe_to_serve is the last check before anything is written to a job.

Every problem found is marked on the item in plain words. Every filing is in the ledger (intake_item) with the steps that take it
back. A file's kind is recorded once (das_file), so a later check reads the record and not the file's name.

PDFs are read in the browser with pdf.js, which the app already ships: this server only scans their bytes. A PDF that arrives with
nobody watching waits as "reading" until a page is open. Standard library only: the web version runs this file in the browser,
where there's no mail and no scanner.
"""
import copy
import email
import email.policy
import email.utils
import hashlib
import html as _html
import json
import mimetypes
import os
import re
import shutil
import struct
import subprocess
import threading
import time
import zipfile
import zlib

import das
import dashist
import uls_import

MB = 1024 * 1024
MAX_FILE = 500 * MB          # one file; the notes' own cap
MAX_HELD = 20 * 1024 * MB    # everything waiting here
MIN_FREE = 1024 * MB         # never fill the disk
TABLE_MAX = 60 * MB          # a table read into memory
ZIP_MEMBERS, ZIP_TOTAL, ZIP_RATIO, ZIP_DEPTH = 2000, 2048 * MB, 200, 3
PDF_READ_MAX = 200 * MB      # past this, only the start and end of a PDF are read for code
TEXT_MAX = 200_000           # the words kept per item, for matching
HOLD_DAYS = 30               # a finished item's held copy goes after this long; its ledger row stays
VIRUS_WAIT = 600

NOT_SCANNED = "not virus-scanned"

# Everything that's a program, or runs when it's opened. Web pages and SVGs are the ones that matter most here: see the note above.
WEB_EXT = {"html", "htm", "xhtml", "xht", "shtml", "svg", "svgz", "mht", "mhtml", "xsl", "xslt", "hta"}
CODE_EXT = WEB_EXT | {
    "exe", "com", "scr", "pif", "cpl", "msi", "msp", "mst", "msc", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "vb", "js", "jse", "mjs", "ws",
    "wsf", "wsh", "sh", "bash", "zsh", "csh", "py", "pyw", "pl", "rb", "php", "phtml", "asp", "aspx", "jsp", "cgi", "dll", "sys", "ocx", "drv", "app",
    "jar", "apk", "deb", "rpm", "dmg", "pkg", "appx", "msix", "gadget", "reg", "inf", "lnk", "url", "scf", "website", "desktop", "iso", "img", "vhd",
    "vhdx", "docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm", "chm", "hlp", "cab", "sct", "wsc", "jnlp", "crx", "xpi", "ipa", "appimage",
    "run", "ksh", "fish", "swf", "class", "pyc", "pyz", "wasm"}
MACRO_EXT = {"docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm"}
DOC_EXT = {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "jpg", "jpeg", "png", "gif", "zip"}  # for the two-types-in-one-name check
JUNK = re.compile(r"^(\.ds_store|thumbs\.db|desktop\.ini|~\$.*|\._.*)$", re.I)
EXT_TYPE = {"pdf": "pdf", "jpg": "jpeg", "jpeg": "jpeg", "png": "png", "gif": "gif", "webp": "webp", "tif": "tiff", "tiff": "tiff", "bmp": "bmp", "heic": "heic", "heif": "heic",
            "zip": "zip", "kmz": "zip", "docx": "zip", "xlsx": "zip", "pptx": "zip", "doc": "ole", "ppt": "ole", "msg": "ole", "rvt": "ole", "gz": "gz", "mbtiles": "sqlite",
            "dwg": "dwg", "ifc": "ifc", "csv": "text", "tsv": "text", "txt": "text", "vcf": "text", "json": "text", "geojson": "text", "dxf": "text", "s1p": "text", "s2p": "text",
            "eml": "text", "kml": "text", "gpx": "text", "wav": "wav", "mp3": "mp3", "mp4": "mp4"}
TYPE_WORD = {"pdf": "a PDF", "jpeg": "a JPEG picture", "png": "a PNG picture", "gif": "a GIF picture", "webp": "a WebP picture", "tiff": "a TIFF picture", "bmp": "a bitmap picture",
             "heic": "a HEIC photo", "zip": "a zip", "ole": "an old Office file", "gz": "a gzip file", "sqlite": "a database", "dwg": "a DWG drawing", "ifc": "an IFC model",
             "text": "plain text", "xml": "plain text", "wav": "a sound file", "mp3": "a sound file", "mp4": "a video", "binary": "something else"}
IMAGE_TYPES = {"jpeg", "png", "gif", "webp", "tiff", "bmp", "heic"}

# kind: label, what happens, and for "own" kinds the tab that takes it and what to press there
KINDS = {
    "plan_set": {"label": "Floor plans", "act": "file"}, "spec_sheet": {"label": "Spec sheet", "act": "file"}, "cal_cert": {"label": "Calibration certificate", "act": "file"},
    "consent": {"label": "Consent letter", "act": "file"}, "rebroadcast": {"label": "Rebroadcast agreement", "act": "file"}, "permit": {"label": "Permit", "act": "file"},
    "ahj_policy": {"label": "AHJ policy or checklist", "act": "file"}, "test_report": {"label": "Test report", "act": "file"},
    "sealed_report": {"label": "Sealed report from RF Recon", "act": "file"}, "as_built": {"label": "As-built drawings", "act": "file"},
    "sealed_drawings": {"label": "Sealed drawings", "act": "file"}, "sequence": {"label": "Sequence of operations", "act": "file"},
    "maintenance": {"label": "Maintenance agreement", "act": "file"}, "b03": {"label": "B-03 certificate", "act": "file"}, "operator_cert": {"label": "Operator certificate", "act": "file"},
    "pass_through": {"label": "Radio shop pass-through document", "act": "file"}, "survey_info": {"label": "RF survey information", "act": "file"},
    "design_approval": {"label": "Design approval", "act": "file"}, "photo": {"label": "Photo", "act": "file"}, "audio": {"label": "Audio", "act": "file"},
    "email": {"label": "Email", "act": "file"}, "drawing": {"label": "Drawing RF Recon can't read", "act": "file"}, "dxf": {"label": "DXF drawing", "act": "file"},
    "equipment": {"label": "Equipment list", "act": "file"}, "document": {"label": "Document", "act": "file"}, "scan": {"label": "Scanned PDF", "act": "file"},
    "contacts": {"label": "Contacts", "act": "fill"},
    "grid": {"label": "Grid test results", "act": "press"}, "sweep": {"label": "Sweep", "act": "press"}, "price_list": {"label": "Price list", "act": "press"},
    "quote": {"label": "Supplier quote", "act": "press"}, "pattern": {"label": "Antenna pattern", "act": "press"}, "capture": {"label": "Capture", "act": "press"},
    "layer": {"label": "Map layer", "act": "press"},
    # these can't be placed from the file alone: the press keeps a copy in Files, and the job's own tab places the readings
    "walk": {"label": "Walk log", "act": "press", "tab": "grid"}, "compass": {"label": "COMPASS report", "act": "press", "tab": "grid"},
    "noise": {"label": "Noise log", "act": "press", "tab": "commission"}, "gain": {"label": "BDA gain table", "act": "press", "tab": "commission"},
    "job_json": {"label": "RF Recon job", "act": "own", "tab": "das", "home": "DAS, Import jobs"},
    "talkgroups": {"label": "Talk groups", "act": "own", "tab": "map", "home": "the emitter's page: the file doesn't say whose they are"},
    "labels": {"label": "Frequency labels", "act": "own", "tab": "data", "home": "Data & updates, Labels"},
    "opencellid": {"label": "Cell sites (OpenCelliD)", "act": "own", "tab": "cells", "home": "Cell sites, Import"},
    "fcc_grantee": {"label": "FCC grantee list", "act": "own", "tab": "data", "home": "Data & updates, FCC ID"},
    "fcc_grants": {"label": "FCC grant search", "act": "own", "tab": "data", "home": "Data & updates, FCC ID: the file doesn't say what the search was by"},
    "basemap": {"label": "Base map", "act": "own", "tab": "map", "home": "Map style, Add a base map"},
    "kit": {"label": "RF Recon install kit", "act": "own", "tab": "data", "home": "Data & updates: Intake never installs anything"},
    "fieldpack": {"label": "Field pack", "act": "own", "tab": "data", "home": "the web version or RF Recon lite, on the device it's for"},
}
PRESS_TO_TAB = {k: v["tab"] for k, v in KINDS.items() if v["act"] == "press" and v.get("tab")}
FIRM_KINDS = {"contacts", "price_list", "pattern", "capture", "layer"}  # need no job
PICKABLE = [k for k, v in KINDS.items() if v["act"] != "own"]
LOCK = threading.Lock()


def label_of(kind):
    return (KINDS.get(kind) or {}).get("label") or "Not known"


# the scan on tagged mail's attachments (from_mail, dasmail._save_atts): raised with Logan 11/5, no answer; on since 11/7 on Cody's
# "do fix" (Logan to be told). A mail attachment is checked as a drop is, and a refused one waits in the drop spot with its reason.
# RF_RECON_MAIL_SCAN=0 turns it off
MAIL_SCAN = os.environ.get("RF_RECON_MAIL_SCAN", "1") != "0"


def stage_dir():
    """Where items wait. Not the shared job folders: a refused file must never reach a folder other people's Drive shows them."""
    d = os.environ.get("RF_RECON_INTAKE") or os.path.join(uls_import.DATA_DIR, "intake")
    os.makedirs(d, exist_ok=True)
    return d


def held(iid):
    return os.path.join(stage_dir(), f"{iid:08d}.held")


def clean_name(name):
    return das.safe_name(os.path.basename(str(name or "").replace("\\", "/")))


def ext_of(name):
    n = str(name or "").rstrip(" .").lower()
    return n.rsplit(".", 1)[1] if "." in n else ""


# ---------------------------------------------------------------- what a file really is

WEB_RE = re.compile(rb"<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>/]|<iframe[\s>]|<object[\s>]|<embed[\s>]|<frameset[\s>]|<applet[\s>]"
                    rb"|<meta\s+http-equiv|<\?xml-stylesheet|http://www\.w3\.org/1999/xhtml", re.I)
SVG_RE = re.compile(rb"<svg[\s>]|http://www\.w3\.org/2000/svg", re.I)
MAIL_RE = re.compile(rb"^(?:[A-Za-z][A-Za-z0-9-]*:[^\n]*\r?\n|[ \t][^\n]*\r?\n){2,}", re.M)
XML_ROOT = re.compile(rb"^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--.*?-->\s*)*<([A-Za-z][\w:.-]*)", re.S)
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _utf8(raw):
    """Windows writes some text as UTF-16: every reader here takes UTF-8."""
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        try:
            return raw.decode("utf-16").encode("utf-8")
        except UnicodeError:
            return raw
    return raw


def _is_text(h):
    if not h:
        return True
    if b"\x00" in h[:8192]:
        return False
    odd = sum(1 for c in h[:4096] if c < 9 or 13 < c < 32)
    return odd * 10 < min(len(h), 4096)


def sniff(head):
    """The file's type from its first bytes, whatever its name says."""
    h = head
    if h[:5] == b"%PDF-":
        return "pdf"
    if h[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
        return "zip"
    if h[:8] == OLE_MAGIC:
        return "ole"
    if h[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if h[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if h[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":
        return "webp"
    if h[:4] == b"RIFF" and h[8:12] == b"WAVE":
        return "wav"
    if h[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if h[4:8] == b"ftyp":
        return "heic" if h[8:12].lower() in (b"heic", b"heix", b"mif1", b"msf1", b"hevc") else "mp4"
    if h[:3] == b"ID3" or h[:2] in (b"\xff\xfb", b"\xff\xf3"):
        return "mp3"
    if h[:2] == b"\x1f\x8b":
        return "gz"
    if h[:16] == b"SQLite format 3\x00":
        return "sqlite"
    if h[:4] == b"Rar!" or h[:6] == b"7z\xbc\xaf\x27\x1c":
        return "archive"
    if h[:4] == b"AC10":
        return "dwg"
    if h[:12] == b"ISO-10303-21":
        return "ifc"
    if h[:4] == b"\x7fELF" or h[:4] in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf"):
        return "exe"
    if h[:8] == b"L\x00\x00\x00\x01\x14\x02\x00":
        return "exe"  # a Windows shortcut
    if h[:2] == b"MZ" and not _is_text(h):
        return "exe"
    if h[:2] == b"BM" and len(h) > 26 and not _is_text(h):
        return "bmp"
    u = _utf8(h)
    if u.lstrip()[:2] == b"#!":
        return "exe"
    if not _is_text(u):
        return "binary"
    root = XML_ROOT.match(u)
    tag = (root.group(1).split(b":")[-1].lower() if root else b"")
    if tag in (b"kml", b"gpx", b"custommapsource"):
        return "xml"  # a KML's balloons carry HTML, and it's served as a download: not a web page
    if tag == b"svg" or SVG_RE.search(u[:65536]):
        return "svg"
    if tag == b"html" or (not MAIL_RE.match(u) and WEB_RE.search(u[:65536])):
        return "web"
    if root and u.lstrip()[:1] == b"<":
        return "xml"
    if b"%PDF-" in h[:1024]:
        return "pdf"
    return "text"


PROGRAM = "This is a program. RF Recon doesn't keep programs: they can run on the computer of whoever opens them."
WEB_PAGE = "This is a web page. A web page saved in a job's Files would run as whoever opens it, so it can't go there. Save it as a PDF."
SVG_PIC = "This is an SVG picture. SVGs can carry code that runs when they're opened, so they can't go in Files. Export it as a PNG or a PDF."
MACROS = "This Office file carries macros, which are programs inside the document. Save it without them, as .xlsx, .docx or a PDF."


def _runs_code(ext, typ):
    if typ == "web":
        return WEB_PAGE
    if typ == "svg":
        return SVG_PIC
    if typ == "exe":
        return PROGRAM
    if ext in ("svg", "svgz"):
        return SVG_PIC
    if ext in WEB_EXT:
        return WEB_PAGE
    if ext in MACRO_EXT:
        return MACROS
    if ext == "msi" and typ == "text":
        return None  # a Planet antenna pattern: the same ending as a Windows installer, told apart by what's inside
    if ext in CODE_EXT:
        return PROGRAM
    return None


def _safe_to_serve(name):
    """The last check before a file reaches a job's Files. app.py opens text and image types in the browser, so a name that maps to
    anything a browser runs is out, whatever this machine's own list of types says."""
    ext = ext_of(name)
    if ext in CODE_EXT and not (ext == "msi"):
        return False
    t = (mimetypes.guess_type(str(name or "").rstrip(" ."))[0] or "").lower()
    return not (t.startswith(("text/", "image/")) and re.search(r"html|xml|svg|javascript|ecmascript|xsl", t))


def _pdf_flags(path, size, out):
    """What a PDF carries, read from its bytes: code, actions on opening, a lock, files packed inside. Cross-reference streams hide
    objects, so object streams are opened too; a hex-escaped name ("/J#61vaScript") is read as what it spells."""
    with open(path, "rb") as fh:
        if size > PDF_READ_MAX:
            raw = fh.read(PDF_READ_MAX // 2)
            fh.seek(size - PDF_READ_MAX // 2)
            raw += fh.read()
            out["problems"].append({"level": "warn", "text": f"This PDF is {size // MB} MB: only its start and end were checked for code."})
        else:
            raw = fh.read()
    if re.search(rb"/[A-Za-z]{0,14}#[0-9A-Fa-f]{2}", raw):
        raw = re.sub(rb"/[A-Za-z0-9#]{1,40}", lambda m: re.sub(rb"#([0-9A-Fa-f]{2})", lambda x: bytes([int(x.group(1), 16)]), m.group(0)), raw)
    parts, i = [], 0
    while True:  # what's outside the streams: inside them, three-byte names turn up by chance in a big file
        a = raw.find(b"stream", i)
        if a < 0:
            parts.append(raw[i:])
            break
        if raw[a - 3:a] == b"end":
            parts.append(raw[i:a + 6])
            i = a + 6
            continue
        parts.append(raw[i:a])
        b = raw.find(b"endstream", a)
        if b < 0:
            break
        i = b + 9
    plain, inner, spent = b"".join(parts), [], 0
    for m in re.finditer(rb"/ObjStm", raw):
        a = raw.find(b"stream", m.end(), m.end() + 4096)
        b = raw.find(b"endstream", a) if a >= 0 else -1
        if b < 0 or spent > 256 * MB:
            continue
        try:
            d = zlib.decompressobj().decompress(raw[a + 6:b].lstrip(b"\r\n"), 16 * MB)
        except zlib.error:
            continue
        spent += len(d)
        inner.append(d)
    all_ = plain + b"\n".join(inner)
    code = next((w for w in (b"/JavaScript", b"/Launch", b"/ImportData", b"/GoToE", b"/RichMedia") if w in raw or w in all_), None)
    if code is None and re.search(rb"/JS[\s(<\[/]", all_):
        code = b"/JavaScript"
    if code in (b"/JavaScript", b"/RichMedia"):
        out["refused"] = "This PDF carries code (JavaScript or a media player). RF Recon doesn't keep PDFs with code in them. Ask for a flat copy, or print it to a new PDF."
    elif code:
        out["refused"] = "This PDF can start another program or pull in data when it's opened. RF Recon doesn't keep those. Ask for a flat copy, or print it to a new PDF."
    m = re.search(rb"/OpenAction\s*(<<.{0,600}?>>|\[.{0,120}?\]|(\d+)\s+(\d+)\s+R)", all_, re.S)
    if m and not out["refused"]:
        body = m.group(1)
        if m.group(2):
            o = re.search(rb"\b" + m.group(2) + rb"\s+" + m.group(3) + rb"\s+obj(.{0,600})", all_, re.S)
            body = o.group(1) if o else b""
        act = re.search(rb"/S\s*/([A-Za-z]+)", body)
        if act and act.group(1) not in (b"GoTo",):  # a plain "open at this page" is every other PDF: anything else does something by itself
            out["refused"] = "This PDF does something by itself when it's opened. RF Recon doesn't keep those. Ask for a flat copy, or print it to a new PDF."
    out["pdf_encrypted"] = b"/Encrypt" in plain
    if b"/EmbeddedFile" in all_:
        out["hold"] = "This PDF has another file packed inside it. Open it in a PDF reader and check what that is before it goes on a job."
    if not out["refused"] and b"%%EOF" not in raw[-2048:] and size <= PDF_READ_MAX:
        out["problems"].append({"level": "warn", "text": "This PDF may be cut off: it has no proper end."})


def _xml_bomb(z, n):
    with z.open(n) as fh:
        return bool(re.search(rb"<!DOCTYPE|<!ENTITY", fh.read(4096), re.I))


def _climbs(name):
    n = name.replace("\\", "/")
    return n.startswith("/") or re.match(r"^[A-Za-z]:", n) is not None or ".." in n.split("/")


def _zip_flags(path, ext, size, out):
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        out["corrupt"] = "This zip is damaged and won't open."
        return
    with z:
        infos = z.infolist()
        if len(infos) > ZIP_MEMBERS:
            out["refused"] = f"This zip holds {len(infos):,} files, over the {ZIP_MEMBERS:,} RF Recon opens. Files packed like that are usually built to swamp whatever opens them."
            return
        total = sum(i.file_size for i in infos)
        if total > ZIP_TOTAL or (total > 64 * MB and total / max(1, sum(i.compress_size for i in infos)) > ZIP_RATIO):
            out["refused"] = "This zip unpacks to far more than its size, which is how a zip bomb works. It wasn't opened."
            return
        names = [i.filename.replace("\\", "/") for i in infos]
        for i in infos:
            if _climbs(i.filename) or (i.external_attr >> 16) & 0o170000 == 0o120000:
                out["refused"] = f"A file in this zip tries to land outside the folder it's unpacked to ({i.filename[:80]}). It wasn't opened."
                return
        low = {n.lower() for n in names}
        sub = "docx" if "word/document.xml" in low else "xlsx" if "xl/workbook.xml" in low else "pptx" if "ppt/presentation.xml" in low else ""
        if any(n.endswith("vbaproject.bin") for n in low):
            out["refused"] = MACROS
            return
        if "classes.dex" in low or ("meta-inf/manifest.mf" in low and any(n.endswith(".class") for n in low)):
            out["refused"] = PROGRAM
            return
        if sub or ext == "kmz":
            if any(i.flag_bits & 1 for i in infos):
                out["locked"] = "This file is locked with a password. RF Recon needs an unlocked copy."
                return
        out["sub"] = sub or ("kmz" if ext == "kmz" or "doc.kml" in low else "kit" if "kit.json" in low else "archive")
        if sub == "xlsx":
            try:
                if any(_xml_bomb(z, n) for n in names if n.lower() in ("xl/sharedstrings.xml", "xl/worksheets/sheet1.xml")):
                    out["refused"] = "This workbook defines its own XML entities, which is how an XML bomb works. It wasn't opened."
                    return
            except (zipfile.BadZipFile, RuntimeError, OSError, zlib.error):
                out["corrupt"] = "This workbook is damaged and won't open."
                return
        if out["sub"] == "archive" and any(i.flag_bits & 1 for i in infos):
            out["locked"] = "This zip is locked with a password. RF Recon needs an unlocked copy."


def _ole(raw):
    """A compound file's streams ([MS-CFB]): {path: (start, size)} and a reader. Old Office files and Outlook .msg files are these."""
    if raw[:8] != OLE_MAGIC or len(raw) < 512:
        raise ValueError("not a compound file")
    ss, ms = 1 << struct.unpack_from("<H", raw, 30)[0], 1 << struct.unpack_from("<H", raw, 32)[0]
    if ss not in (512, 4096) or ms != 64:
        raise ValueError("odd sector size")
    n_fat, dir_at = struct.unpack_from("<I", raw, 44)[0], struct.unpack_from("<I", raw, 48)[0]
    cut, mini_at, n_mini, dif_at, n_dif = struct.unpack_from("<5I", raw, 56)
    sector = lambda i: raw[(i + 1) * ss:(i + 2) * ss]  # noqa: E731
    fat_secs = [x for x in struct.unpack_from("<109I", raw, 76) if x < 0xFFFFFFFA]
    seen = set()
    while dif_at < 0xFFFFFFFA and dif_at not in seen and len(seen) <= n_dif + 1:
        seen.add(dif_at)
        vals = struct.unpack(f"<{ss // 4}I", sector(dif_at))
        fat_secs += [x for x in vals[:-1] if x < 0xFFFFFFFA]
        dif_at = vals[-1]
    fat = []
    for s in fat_secs[:max(n_fat, 1) + 1024]:
        b = sector(s)
        fat += struct.unpack(f"<{len(b) // 4}I", b[:len(b) // 4 * 4])

    def chain(s, tab):
        out, seen_ = [], set()
        while s < 0xFFFFFFFA and s < len(tab) and s not in seen_:
            seen_.add(s)
            out.append(s)
            s = tab[s]
        return out

    def read(s):
        return b"".join(sector(x) for x in chain(s, fat))
    d = read(dir_at)
    ents = []
    for i in range(0, len(d) - 127, 128):
        e = d[i:i + 128]
        ln = struct.unpack_from("<H", e, 64)[0]
        ents.append({"name": e[:max(0, ln - 2)].decode("utf-16-le", "replace"), "type": e[66], "l": struct.unpack_from("<I", e, 68)[0], "r": struct.unpack_from("<I", e, 72)[0],
                     "c": struct.unpack_from("<I", e, 76)[0], "start": struct.unpack_from("<I", e, 116)[0], "size": struct.unpack_from("<Q", e, 120)[0]})
    if not ents:
        raise ValueError("no directory")
    mini_fat = read(mini_at) if n_mini else b""
    mfat = list(struct.unpack(f"<{len(mini_fat) // 4}I", mini_fat[:len(mini_fat) // 4 * 4]))
    ministream = read(ents[0]["start"]) if ents[0]["start"] < 0xFFFFFFFA else b""
    tree, seen_n = {}, set()

    def walk(i, pre):
        if i >= len(ents) or i in seen_n:
            return
        seen_n.add(i)
        e = ents[i]
        walk(e["l"], pre)
        walk(e["r"], pre)
        if e["type"] == 2:
            tree[pre + e["name"]] = e
        elif e["type"] == 1:
            tree[pre + e["name"] + "/"] = e
            walk(e["c"], pre + e["name"] + "/")
    walk(ents[0]["c"], "")

    def stream(name):
        e = tree[name]
        if e["size"] < cut:
            return b"".join(ministream[s * ms:(s + 1) * ms] for s in chain(e["start"], mfat))[:e["size"]]
        return read(e["start"])[:e["size"]]
    return tree, stream


def _ole_flags(path, ext, size, out):
    if size > 256 * MB:
        return
    with open(path, "rb") as fh:
        raw = fh.read()
    try:
        tree, _ = _ole(raw)
    except (ValueError, struct.error, IndexError):
        out["corrupt"] = "This Office file is damaged and won't open."
        return
    names = {k.rsplit("/", 2)[-1 if not k.endswith("/") else -2].lower() for k in tree}
    if names & {"_vba_project", "vba", "macros"} or any(k.lower().startswith(("macros/", "_vba_project_cur/", "vba/")) for k in tree):
        out["refused"] = MACROS
    elif "encryptedpackage" in names or "encryptioninfo" in names:
        out["locked"] = "This Office file is locked with a password. RF Recon needs an unlocked copy."
    elif ext in ("msi", "msp", "mst"):
        out["refused"] = PROGRAM


def scan_file(name, path, size):
    """Every check that needs nothing installed. {type, sub, refused, locked, corrupt, hold, problems, virus}: refused and hold say why
    in words a person can act on."""
    base = str(name or "")
    ext = ext_of(base)
    with open(path, "rb") as fh:
        head = fh.read(65536)
    typ = sniff(head) if size else "empty"
    out = {"type": typ, "sub": "", "refused": None, "locked": None, "corrupt": None, "hold": None, "problems": [], "virus": NOT_SCANNED}
    if not size:
        out["corrupt"] = "This file is empty."
        return out
    if re.search("[‪-‮⁦-⁩‎‏]", base):
        out["refused"] = "This file's name has hidden characters that make it look like a different type. That's a trick: it wasn't opened."
        return out
    bits = base.lower().split(".")[1:]
    why = _runs_code(ext, typ)
    if len(bits) >= 2 and bits[-2] in (DOC_EXT | CODE_EXT) and bits[-1] != bits[-2] and not why:
        out["problems"].append({"level": "warn", "text": f"This name has two file types in it (.{bits[-2]}.{bits[-1]}). Check it's what it says."})
    if why:
        out["refused"] = why
        return out
    want = EXT_TYPE.get(ext)
    if want and want != typ and not ({want, typ} <= {"text", "xml"}):
        if want in IMAGE_TYPES and typ in IMAGE_TYPES:
            out["problems"].append({"level": "warn", "text": f"Its name ends .{ext}, but it's really {TYPE_WORD.get(typ, typ)}."})
        elif typ == "ole" and want == "zip":
            pass  # a locked .xlsx or .docx is a compound file: _ole_flags says so
        elif not (ext == "gz" or (ext == "xls" and typ == "text")):
            out["hold"] = f"Its name says .{ext}, but the file inside is {TYPE_WORD.get(typ, 'something else')}. It may be misnamed, or disguised."
    if typ == "pdf":
        _pdf_flags(path, size, out)
    elif typ == "zip":
        _zip_flags(path, ext, size, out)
    elif typ == "ole":
        _ole_flags(path, ext, size, out)
    elif typ == "png":
        with open(path, "rb") as fh:
            fh.seek(max(0, size - 12))
            if b"IEND" not in fh.read():
                out["problems"].append({"level": "warn", "text": "This picture may be cut off: it has no proper end."})
    elif typ == "xml" and re.search(rb"<!DOCTYPE|<!ENTITY", head, re.I):
        out["refused"] = "This file defines its own XML entities, which is how an XML bomb works. It wasn't opened."
    elif typ == "archive":
        out["hold"] = "This is a RAR or 7z archive, which RF Recon can't open. Save it as a zip."
    return out


def _scanner():
    for exe in ("clamdscan", "clamscan"):
        p = shutil.which(exe)
        if p:
            return exe, p
    return None, None


def virus_pass(paths):
    """ClamAV, when it's on this machine: {path: signature} of what it found, or None when there's no scanner, or {"error": why}.
    clamdscan (the daemon, already loaded) comes first: clamscan loads every signature again on each run, so a batch is one call."""
    exe, p = _scanner()
    if not p or not paths:
        return None
    try:
        r = subprocess.run([p, "--no-summary", *(["--fdpass"] if exe == "clamdscan" else []), *paths], capture_output=True, text=True, timeout=VIRUS_WAIT,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError) as e:
        return {"error": str(e)[:160]}
    if r.returncode not in (0, 1):
        return {"error": (r.stderr or r.stdout or f"exit {r.returncode}").strip()[:160]}
    hits = {}
    for ln in (r.stdout or "").splitlines():
        m = re.match(r"(.+?):\s+(.+?)\s+FOUND\s*$", ln)
        if m:
            hits[os.path.normpath(m.group(1))] = m.group(2)
    return hits


# ---------------------------------------------------------------- old emails

def _body_text(msg):
    text, htm = "", ""
    for part in msg.walk():
        if part.is_multipart() or part.get_filename() or (part.get_content_disposition() or "") == "attachment":
            continue
        ct = part.get_content_type()
        try:
            got = part.get_content()
        except (LookupError, ValueError, KeyError):
            got = (part.get_payload(decode=True) or b"").decode("utf-8", "replace")
        if ct == "text/plain" and not text:
            text = got
        elif ct == "text/html" and not htm:
            htm = got
    if not text and htm:
        htm = re.sub(r"(?is)<(script|style).*?</\1>", " ", htm)
        text = _html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", htm)))
    return str(text)


def parse_eml(raw):
    """An .eml file: {subject, from, from_name, to, date, text, attachments: [{name, data}]}. mailbox.py reads the same format, but it needs
    the mail libraries, which the web version doesn't have."""
    msg = email.message_from_bytes(raw, policy=email.policy.default)
    atts = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        fname = part.get_filename()
        if fname or (part.get_content_disposition() or "") == "attachment":
            atts.append({"name": str(fname or "attachment"), "data": part.get_payload(decode=True) or b""})
    who = email.utils.parseaddr(str(msg.get("From") or ""))
    return {"subject": str(msg.get("Subject") or ""), "from": who[1].lower(), "from_name": who[0], "to": str(msg.get("To") or ""), "date": str(msg.get("Date") or ""),
            "text": _body_text(msg), "attachments": atts}


def parse_msg(raw):
    """An Outlook .msg file, in the same shape, from its compound-file streams. Properties are named __substg1.0_ then four hex digits of
    property and four of type: 001F is UTF-16 text, 001E is 8-bit text, 0102 is bytes."""
    tree, stream = _ole(raw)

    def prop(code, pre=""):
        for typ, enc in (("001F", "utf-16-le"), ("001E", "cp1252")):
            n = f"{pre}__substg1.0_{code}{typ}"
            if n in tree:
                return stream(n).decode(enc, "replace").rstrip("\x00")
        return ""
    head = prop("007D")
    m = re.search(r"^Date:\s*(.+)$", head, re.M)
    atts = []
    for k in sorted(x for x in tree if x.endswith("/") and x.startswith("__attach_version1.0_")):
        name = prop("3707", k) or prop("3704", k) or prop("3001", k) or "attachment"
        n = f"{k}__substg1.0_37010102"
        if n in tree:
            atts.append({"name": name, "data": stream(n)})
    return {"subject": prop("0037"), "from": (prop("0C1F") or prop("5D01")).lower(), "from_name": prop("0C1A"), "to": prop("0E04"), "date": (m.group(1).strip() if m else ""),
            "text": prop("1000"), "attachments": atts}


# ---------------------------------------------------------------- what kind of thing it is

MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
DATE = r"(\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|\d{1,2}[ -][A-Za-z]{3,9}\.?[ -]\d{4})"
ADDRESS_RE = re.compile(r"\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Way|Circle|Cir)\b\.?(?:,\s*[A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?)?")


def to_date(s):
    """A date in any of the usual spellings, as YYYY-MM-DD, or "" when it isn't one."""
    t = str(s or "").strip().replace(",", " ")
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", t)
    if m:
        return t
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", t)
    if m:
        y = int(m.group(3)) + (2000 if len(m.group(3)) == 2 else 0)
        return f"{y:04d}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    m = re.fullmatch(r"([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\s+(\d{4})", t)
    if m and m.group(1).lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(1).lower()]:02d}-{int(m.group(2)):02d}"
    m = re.fullmatch(r"(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*\.?[\s-]+(\d{4})", t)
    if m and m.group(2).lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    return ""


def today():
    return time.strftime("%Y-%m-%d")


def days_to(ymd):
    try:
        return int((time.mktime(time.strptime(ymd, "%Y-%m-%d")) - time.mktime(time.strptime(today(), "%Y-%m-%d"))) / 86400 + .5)
    except ValueError:
        return None


DOC_WORDS = [
    ("cal_cert", r"certificate of calibration|calibration certificate|calibration report", 4), ("cal_cert", r"\bcalibrat(?:ed|ion)\b.{0,300}\b(?:due|next cal|recal)", 2),
    # the rule's number alone is weak: every booster's data sheet cites 90.219, and one was filed as a consent letter (11/6)
    ("consent", r"retransmission consent|consent to (?:re)?transmi|letter of consent|licensee consent|consent letter", 4), ("consent", r"90\.219|\b20\.21\b", 2),
    ("rebroadcast", r"rebroadcast|retransmission agreement", 4), ("sequence", r"sequence of operations?", 4),
    ("maintenance", r"maintenance (?:agreement|contract)|inspection and maintenance", 4), ("b03", r"\bb-?03\b", 4),
    ("operator_cert", r"operator(?:'s)? certif|training certificate|certified operator", 4), ("pass_through", r"pass.?through|alignment document", 3),
    ("survey_info", r"survey information", 4), ("design_approval", r"design approval", 4), ("as_built", r"\bas.?built", 4),
    ("permit", r"\bpermit (?:no\b|number|#)|building permit|electrical permit|fire permit|permit issued", 4),
    ("ahj_policy", r"\berces\b|ifc 510|nfpa 1225|emergency responder radio", 2), ("ahj_policy", r"\b(?:policy|guideline|checklist|requirements)\b", 1),
    ("test_report", r"seehawk|ibwave|test report|acceptance test|grid test", 3),
    ("spec_sheet", r"data ?sheet|\bspecifications\b|ul 2524|\bfcc id\b|technical data", 3),
    ("plan_set", r"floor plan|sheet (?:no|number)\b|\b[aest]-?\d{3}\b|reflected ceiling|\bscale\s*:", 3), ("sealed_drawings", r"professional (?:engineer|seal)|\bp\.?e\.? (?:seal|stamp)|\bsealed drawings?", 3),
]


def word_kind(text, wide_page=False, letter_page=False):
    """(kind, score, the words that decided it, close second). Scored rather than matched in order: most of these documents mention each
    other, so the one that says the most about itself wins, and a near tie is said to be one."""
    t = (text or "").lower()
    score, why = {}, {}
    for kind, pat, w in DOC_WORDS:
        m = re.search(pat, t, re.S)
        if m:
            score[kind] = score.get(kind, 0) + w
            why.setdefault(kind, re.sub(r"\s+", " ", m.group(0))[:40])
    if wide_page:
        score["plan_set"] = score.get("plan_set", 0) + 4
        why.setdefault("plan_set", "a large drawing-size page")
    elif letter_page and "plan_set" in score:
        score["plan_set"] -= 2
    if not score:
        return None, 0, "", None
    rank = sorted(score, key=lambda k: -score[k])
    top, second = rank[0], (rank[1] if len(rank) > 1 else None)
    return top, score[top], why.get(top, ""), second if second and score[second] >= score[top] else None


def _cert_facts(text):
    f = {}
    # past here the serials and due dates are the lab's own standards', not this instrument's. Same line as readers.js STANDARDS
    text = re.split(r"\bstandards? used\b|\breference standards?\b|\btraceab\w+ to\b|\btest equipment used\b|\bequipment used\b|\bstandards? (?:list|table)\b", text or "", maxsplit=1, flags=re.I)[0]
    m = re.search(r"(?:serial(?:\s*(?:no\.?|number|#))?|s/n)\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9-]{2,})", text, re.I)
    if m:
        f["serial"] = m.group(1)
    m = re.search(r"(?:calibration date|date of calibration|date calibrated|calibrated(?: on)?|cal date)\s*[:#.]?\s*" + DATE, text, re.I)
    if m:
        f["cal"] = to_date(m.group(1))
    m = re.search(r"(?:due date|calibration due|next calibration|next cal|recalibration(?: date)?|due|expires|expiration(?: date)?|valid (?:until|through))\s*[:#.]?\s*" + DATE, text, re.I)
    if m:
        f["due"] = to_date(m.group(1))
    m = re.search(r"\bmodel(?:\s*(?:no\.?|number|#))?\s*[:#]\s*([A-Za-z0-9][\w./-]*(?: [A-Za-z0-9][\w./-]*)?)", text, re.I)
    if m:  # to save typing if a person adds it to the register. A PDF's words run on, so the next label can follow the model
        f["model"] = re.split(r"\s+(?:serial|s/n|sn|date|cal\w*)\b", m.group(1), flags=re.I)[0]
    return f


def _exif(path):
    """A JPEG's capture time and place. {when, lat, lon}, any of them missing. Only the parts Intake uses."""
    out = {}
    try:
        with open(path, "rb") as fh:
            data = fh.read(256 * 1024)
        i = 2
        while i + 4 < len(data) and data[i] == 0xFF:
            mark, ln = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
            if mark == 0xE1 and data[i + 4:i + 10] == b"Exif\x00\x00":
                t = data[i + 10:i + 2 + ln]
                e = "<" if t[:2] == b"II" else ">"

                def tags(off):
                    n = struct.unpack_from(e + "H", t, off)[0]
                    return {struct.unpack_from(e + "H", t, off + 2 + k * 12)[0]: off + 2 + k * 12 for k in range(n)}

                def rats(at, n):
                    o = struct.unpack_from(e + "I", t, at + 8)[0]
                    return [struct.unpack_from(e + "II", t, o + j * 8) for j in range(n)]
                ifd0 = tags(struct.unpack_from(e + "I", t, 4)[0])
                if 0x8769 in ifd0:
                    sub = tags(struct.unpack_from(e + "I", t, ifd0[0x8769] + 8)[0])
                    if 0x9003 in sub:
                        o = struct.unpack_from(e + "I", t, sub[0x9003] + 8)[0]
                        out["when"] = t[o:o + 10].decode("ascii", "replace").replace(":", "-")
                if 0x8825 in ifd0:
                    g = tags(struct.unpack_from(e + "I", t, ifd0[0x8825] + 8)[0])
                    if 2 in g and 4 in g:
                        val = lambda at: sum(a / b / 60 ** k for k, (a, b) in enumerate(rats(at, 3)) if b)  # noqa: E731
                        la, lo = val(g[2]), val(g[4])
                        ref = lambda tag: chr(t[g[tag] + 8]) if tag in g else ""  # noqa: E731
                        out["lat"], out["lon"] = -la if ref(1) == "S" else la, -lo if ref(3) == "W" else lo
                break
            i += 2 + ln
    except (OSError, struct.error, IndexError, ZeroDivisionError):
        pass
    return out


def _docx_text(path):
    try:
        with zipfile.ZipFile(path) as z, z.open("word/document.xml") as fh:
            x = fh.read(4 * MB).decode("utf-8", "replace")
        return _html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"</w:p>", "\n", x)))[:TEXT_MAX]
    except (zipfile.BadZipFile, KeyError, OSError, RuntimeError, zlib.error):
        return ""


def _norm_cols(head):
    return {re.sub(r"[^a-z0-9]", "", str(h).lower()): h for h in head}


def _nums(rows, col, limit=400):
    out = []
    for r in rows[:limit]:
        m = re.search(r"-?\d+(?:\.\d+)?", str(r.get(col, "")))
        if m:
            out.append(float(m.group(0)))
    return out


def _table_kind(name, raw):
    """What a table holds, from its columns. -> (kind, confidence, why, facts). Extension alone is never trusted: .txt, .csv and .dat each
    mean five things here. maybe: what it could also be, when the columns can't say."""
    import network
    try:
        fmt, head, rows = das.read_table(name, raw)
    except Exception as e:
        return None, 0, "", {"read_error": str(e)[:160]}
    if len(head) < 2:
        return None, 0, "", {}
    n = _norm_cols(head)
    f = {"rows": len(rows), "columns": [str(h)[:40] for h in head[:20]], "fmt": fmt}
    has = lambda *ks: any(k in n for k in ks)  # noqa: E731
    gm = das.guess_for(fmt, head)
    reads = [k for k in ("dl", "ul", "daq", "ul_daq", "rsrp", "sinr") if k in gm]
    if fmt == "compass":
        return "compass", .98, "A Cel-Fi COMPASS report", dict(f, tab="grid")
    if has("radio") and has("mcc") and has("net", "mnc") and has("area", "lac", "tac") and has("cell", "cid"):
        return "opencellid", .95, "OpenCelliD columns", f
    if has("granteecode"):
        return "fcc_grantee", .95, "A Grantee Code column", f
    if has("alphatag") and has("frequency", "freq") and has("license", "callsign"):
        return "labels", .95, "Frequency, License and Alpha Tag columns", f
    tg = das.guess_mapping(head, network.TG_ALIASES)
    if (tg.get("hex") or (tg.get("dec") and has("decimal", "tgid", "talkgroup", "talkgroupid"))) and not reads:
        return "talkgroups", .9, "Decimal or Hex talk group columns", f
    if "floor" in gm and "grid" in gm and reads:
        vals = _nums(rows, gm[reads[0]])
        if not rows or (vals and sum(v <= 40 for v in vals) >= .8 * len(vals)):
            return "grid", .95, f"{gm['floor']}, {gm['grid']} and {gm[reads[0]]} columns", dict(f, map=gm)
    if has("timestamp") and has("networktech") and has("level") and has("operatorname", "operator"):
        return "walk", .95, "A G-NetTrack Pro log", f
    if "time" in gm and "rsrp" in gm:
        return "walk", .85, f"{gm['time']} and {gm['rsrp']} columns", f
    cm = das.guess_mapping(head, das.CONTACT_ALIASES)
    pm = das.guess_mapping(head, das.PART_ALIASES)
    qm = das.guess_mapping(head, das.QUOTE_ALIASES)
    named = has("firstname", "givenname", "lastname", "familyname", "surname") or "name" in cm or "org" in cm or "email" in cm
    if named and ("phone" in cm or "email" in cm) and "price" not in pm and "floor" not in gm:
        return "contacts", .95, "Name, phone or email columns", f
    if ("part" in pm or "item" in pm) and ("unit_price" in qm or "price" in pm or "qty" in qm):
        f["cols"] = {k: pm.get(k) for k in ("part", "item", "price", "supplier") if pm.get(k)}
        if "lead_days" in qm and "unit_price" in qm:
            return "quote", .8, f"{qm['unit_price']} and {qm['lead_days']} columns", f
        if "qty" in qm and "unit_price" not in qm:
            return "equipment", .85, f"{qm['qty']} and part columns", f
        if "qty" in qm and "part" in pm:
            return "equipment", .7, f"{qm['qty']} and part columns", dict(f, maybe=["equipment", "quote", "price_list"])
        if "price" in pm:
            return "price_list", .85, f"{pm.get('part') or pm.get('item')} and {pm['price']} columns", f
    band = next((h for k, h in n.items() if re.search(r"band|passband|channel", k)), None)
    if band and any(re.search(r"(ul|up|uplink|dl|down|downlink).*gain|gain.*(ul|up|dl|down)", k) for k in n):
        return "gain", .85, "Band and gain columns", f
    lat, lon = "lat" in gm, "lon" in gm
    if lat and lon and ("freq" in gm or "dl" in gm):
        return "capture", .8, "Position with frequency or level columns", dict(f, maybe=["capture", "layer"])
    level = next((h for k, h in n.items() if re.search(r"dbm|noise|rssi|power|level", k) and not re.search(r"freq|time|date", k)), None)
    if "time" in gm and level:
        vals = _nums(rows, level)
        if vals and all(-200 <= v <= 0 for v in vals):
            return "noise", .6, f"{gm['time']} and {level} columns, no position", dict(f, maybe=["noise", "capture"], ask="Time and level columns could be a noise log or a capture. Pick which.")
    return None, 0, "", f


def recognise(name, path, sc):
    """The kind of a scanned file, from its contents. -> {kind, conf, why, facts, body}. PDFs wait for the browser (read_pdf)."""
    ext, typ, sub = ext_of(name), sc["type"], sc.get("sub")
    size = os.path.getsize(path)
    pre = {"kind": None, "conf": 0, "why": "", "facts": {}, "body": ""}
    by_name = word_kind(re.sub(r"[_+.-]+", " ", os.path.splitext(name)[0]))[0]

    def out(kind, conf, why, **facts):
        return {**pre, "kind": kind, "conf": conf, "why": why, "facts": facts}
    if typ == "pdf":
        return out(None, 0, "")
    if typ in IMAGE_TYPES:
        f = _exif(path) if typ == "jpeg" else {}
        if typ == "heic":
            f["note"] = "Only Safari draws HEIC photos: other browsers can't show this one, though it's kept as it came."
        return out(by_name if by_name in ("as_built", "permit") else "photo", .9, "It's a picture", **f)
    if typ in ("wav", "mp3"):
        return out("audio", .9, "It's a sound file")
    if typ == "mp4":
        return out("document", .6, "It's a video")
    if typ == "dwg" or ext in ("rvt", "ifc") or typ == "ifc":
        return out("drawing", .95, "A DWG, Revit or IFC drawing", note="RF Recon can't read this format. Keep a PDF of it too, or export a DXF for the Design tab.")
    if typ == "sqlite" or ext == "mbtiles":
        return out("basemap" if ext == "mbtiles" else None, .9, "A map tile database" if ext == "mbtiles" else "")
    if ext == "rfpack" or (typ == "gz" and ext == "rfpack"):
        return out("fieldpack", .95, "An RF Recon field pack")
    if typ == "gz":
        return out("opencellid" if re.search(r"cell|mcc|\d{3}", name, re.I) else None, .7, "A gzip file, the way OpenCelliD ships its lists")
    if typ == "zip":
        if sub == "docx":
            body = _docx_text(path)
            k, _, why, _s = word_kind(body + " " + name)
            return {**out(k or "document", .75 if k else .6, f"Words in it: {why}" if why else "A Word document"), "body": body}
        if sub == "pptx":
            return out(by_name or "document", .6, "A PowerPoint file")
        if sub == "kit":
            return out("kit", .95, "It holds kit.json")
        if sub == "kmz":
            return out("capture", .6, "A KMZ", maybe=["capture", "layer"], ask="A KMZ could be a capture or a map layer: that's what you meant by it, not what's in it. Pick which.")
    if typ == "ole":
        return out(by_name or "document", .6, "An old Office file")
    if typ in ("text", "xml") or sub == "xlsx":
        if size > TABLE_MAX:
            return out(None, 0, "", note=f"This is {size // MB} MB of text, too big to read through. Keep it in Files, or bring it in on its own tab.")
        with open(path, "rb") as fh:
            raw = _utf8(fh.read())
        text = raw.decode("utf-8-sig", "replace") if sub != "xlsx" else ""
        head = text[:4096]
        if sub != "xlsx":
            if "BEGIN:VCARD" in head.upper():
                return {**out("contacts", .98, "It's a vCard"), "body": text[:TEXT_MAX]}
            if re.search(r"^\s*HORIZONTAL\s+\d+\s*$", text, re.M | re.I):
                try:
                    p = das.parse_msi(text)
                    return out("pattern", .98, "NAME and HORIZONTAL 360 lines: a Planet antenna pattern", antenna=p["name"] or os.path.splitext(name)[0], make=p["make"], gain=p["gain_dbi"], freq=p["freq_mhz"])
                except ValueError as e:
                    return out("pattern", .7, "It looks like an antenna pattern", bad=str(e)[:200])
            if ext in ("s1p", "s2p") or re.search(r"^\s*#\s*(hz|khz|mhz|ghz)?\s*s\s+(ri|ma|db)\b", text, re.I | re.M) or re.search(r"site\s*master|fieldfox|line\s*sweep|nanovna|rigexpert", head, re.I):
                try:
                    t = das.read_sweep(name, raw)
                    return out("sweep", .95, f"A {t['format']} sweep export", points=t["points"], series=len(t["series"]), instrument=t["instrument"], date=t["date"])
                except ValueError as e:
                    return out("sweep", .6, "It looks like a sweep export", bad=str(e)[:200])
            if ext in ("kml", "gpx") or typ == "xml":
                if re.search(r"<customMapSource", head, re.I):
                    return out("basemap", .95, "A map source file")
                if re.search(r"<gpx[\s>]", head, re.I):
                    return out("capture", .7, "A GPX track", maybe=["capture", "layer"])
                if re.search(r"<kml[\s>]", head, re.I):
                    return out("capture", .6, "A KML", maybe=["capture", "layer"], ask="A KML with points could be a capture or a map layer: that's what you meant by it, not what's in it. Pick which.")
                if re.search(r"<(?:fcc|grant|exportedresults|rows?)\b|fcc", head, re.I):
                    return out("fcc_grants", .7, "An XML export that looks like the FCC's")
                return out(None, 0, "", note="This is an XML file. XML can run in a browser, so it can't go in Files. Bring it in on the tab that reads it.")
            if text.startswith("WigleWifi"):
                return out("capture", .98, "A WiGLE log")
            if ext in ("json", "geojson") or text.lstrip()[:1] in ("{", "["):
                try:
                    j = json.loads(text)
                except ValueError:
                    j = None
                if isinstance(j, dict) and ("rfrecon_das_job" in j or "rfrecon_das_jobs" in j):
                    return out("job_json", .98, "An RF Recon job export", note="Files aren't in a job export.")
                if isinstance(j, dict) and j.get("type") == "FeatureCollection":
                    return out("layer", .9, "A GeoJSON map layer", points=len(j.get("features") or []))
            if re.search(r"^\s*0\s*\r?\n\s*SECTION", text[:400]) or ext == "dxf":
                return out("dxf", .95, "A DXF drawing", note="Open the Design tab to bring its walls in.")
            import captures
            if captures.detect(name, raw) == "sweep":
                return out("capture", .9, "An rtl_power sweep")
        k, conf, why, f = _table_kind(name, raw)
        if k:
            r = out(k, conf, why, **f)
            r["body"] = text[:TEXT_MAX]
            return r
        if ext == "dat":
            try:
                t = das.read_sweep(name, raw)
                return out("sweep", .7, "Two columns of numbers in a .dat", points=t["points"], maybe=["sweep", "noise"], instrument=t["instrument"], date=t["date"])
            except ValueError:
                pass
        if sub == "xlsx":
            return out(by_name or "document", .6, "A workbook, its columns not recognised", columns=f.get("columns"), read_error=f.get("read_error"))
        k2, _, why2, _s = word_kind(text[:TEXT_MAX] + " " + name)
        r = out(k2 or "document", .7 if k2 else .6, f"Words in it: {why2}" if why2 else "Text, not a table RF Recon knows", columns=f.get("columns"))
        r["body"] = text[:TEXT_MAX]
        return r
    return out(None, 0, "", note="RF Recon can't tell what this is.")


# ---------------------------------------------------------------- the ledger

JSON_COLS = {"scan": dict, "checks": dict, "problems": list, "facts": dict, "undo": list}


def _row(r):
    d = dict(r)
    for c, kind in JSON_COLS.items():
        d[c] = json.loads(d[c]) if d.get(c) else kind()
    return d


def _put(con, iid, **kw):
    for c in JSON_COLS:
        if c in kw:
            kw[c] = json.dumps(kw[c])
    con.execute(f"UPDATE intake_item SET {', '.join(k + '=?' for k in kw)} WHERE id=?", (*kw.values(), iid))


def _raw(con, iid):
    r = con.execute("SELECT * FROM intake_item WHERE id=?", (iid,)).fetchone()
    return _row(r) if r else None


class Ctx:
    """Who's asking: the login, and how to reach what lives in app.py. gate(jid, need) raises as app.py's job_gate does."""

    def __init__(self, con, who=None, role=None, gate=None, capture=None, layer=None, unlayer=None, uncapture=None):
        self.who, self.role, self.gate = who, role, gate
        self.vis = dashist.visible(con, who, role)
        self.capture, self.layer, self.unlayer, self.uncapture = capture, layer, unlayer, uncapture
        self.by = dashist.who_now()

    def sees(self, it):
        if self.vis is None:
            return True
        return it.get("job_id") in self.vis or (it.get("who") or "").lower() == (self.who or "").lower()

    def writes(self):
        return self.role in (None, "full", "admin")


def _get(con, iid, ctx):
    it = _raw(con, iid)
    if not it or not ctx.sees(it):
        raise LookupError("That item isn't here any more.")
    return it


def new_batch(con, ctx, job_id=None, label="", source="drop"):
    if job_id is not None:
        ctx.gate(int(job_id), "edit")
    _tidy(con)
    cur = con.execute("INSERT INTO intake_batch(who, source, job_id, label, created_at) VALUES(?,?,?,?,?)", (ctx.who or ctx.by, source, job_id, str(label or "")[:120], das.now()))
    con.commit()
    return cur.lastrowid


def _batch(con, bid, ctx):
    b = con.execute("SELECT * FROM intake_batch WHERE id=?", (bid,)).fetchone()
    if not b or (ctx.vis is not None and (b["who"] or "").lower() != (ctx.who or "").lower()):
        raise LookupError("That drop isn't here any more.")
    return dict(b)


def _room(n):
    used = 0
    with os.scandir(stage_dir()) as it:
        for e in it:
            if e.is_file():
                used += e.stat().st_size
    if used + n > MAX_HELD:
        raise ValueError("Intake is full: too much is waiting. Clear the Needs a look pile first.")
    try:
        free = shutil.disk_usage(stage_dir()).free
    except (AttributeError, NotImplementedError, OSError):  # the web version's in-browser file system doesn't say
        return
    if free - n < MIN_FREE:
        raise ValueError("The disk is nearly full, so this wasn't taken in. Nothing was saved.")


def _tidy(con):
    """The held copy of anything finished more than HOLD_DAYS ago goes, and the words read from it: they're only there to match it to a job, and the
    ledger is in the nightly backup. Its ledger row stays."""
    cut = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - HOLD_DAYS * 86400))
    for r in con.execute("SELECT id FROM intake_item WHERE status IN ('filed','applied','refused','duplicate','unpacked','undone','dropped','kept') AND at<? AND (body IS NOT NULL OR scan IS NOT NULL) LIMIT 500", (cut,)).fetchall():
        try:
            os.remove(held(r["id"]))
        except OSError:
            pass
        con.execute("UPDATE intake_item SET body=NULL WHERE id=?", (r["id"],))


def add_stream(con, bid, name, rel, rfile, n, ctx):
    """One file, streamed to disk: uploads are never read whole into memory here. Returns the new items."""
    b = _batch(con, bid, ctx)
    if n > MAX_FILE:
        raise ValueError(f"That file is {n // MB:,} MB, over the {MAX_FILE // MB} MB Intake takes.")
    _room(n)
    tmp = os.path.join(stage_dir(), f"in-{threading.get_ident()}-{time.time_ns()}.part")
    h, left = hashlib.sha256(), n
    try:
        with open(tmp, "wb") as fh:
            while left > 0:
                chunk = rfile.read(min(left, MB))
                if not chunk:
                    raise ValueError("The upload stopped part way. Nothing was saved.")
                h.update(chunk)
                fh.write(chunk)
                left -= len(chunk)
        return _take(con, b, name, rel or "", tmp, n, h.hexdigest(), ctx)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def add_bytes(con, bid, name, rel, data, ctx, parent=None, grp=None, depth=0, budget=None, hints=None):
    b = _batch(con, bid, ctx)
    tmp = os.path.join(stage_dir(), f"in-{threading.get_ident()}-{time.time_ns()}.part")
    with open(tmp, "wb") as fh:
        fh.write(data)
    try:
        return _take(con, b, name, rel or "", tmp, len(data), hashlib.sha256(data).hexdigest(), ctx, parent, grp, depth, budget, hints)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _take(con, b, name, rel, tmp, size, sha, ctx, parent=None, grp=None, depth=0, budget=None, hints=None):
    """A file on disk becomes an item: scanned, then opened if it's a zip or an email, then recognised."""
    base = clean_name(name)
    if not grp and "/" in rel.replace("\\", "/").strip("/"):
        grp = rel.replace("\\", "/").strip("/").split("/")[0]
    cur = con.execute("INSERT INTO intake_item(batch_id, parent_id, who, name, path, grp, sha256, size, status, at, facts) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                      (b["id"], parent, ctx.by if ctx.who is None else ctx.who, base, str(rel or "")[:400], grp, sha, size, "scanning", das.now(), json.dumps(hints or {})))
    iid = cur.lastrowid
    con.commit()
    os.replace(tmp, held(iid))
    path = held(iid)
    it = {"id": iid, "name": base, "path": rel, "grp": grp, "facts": dict(hints or {})}
    try:
        sc = scan_file(str(name or base), path, size)
    except Exception as e:
        sc = {"type": "binary", "sub": "", "refused": None, "locked": None, "problems": [], "virus": NOT_SCANNED, "hold": None, "corrupt": f"RF Recon couldn't read this file ({type(e).__name__})."}
    made = [iid]
    if sc["refused"] or sc["corrupt"] or sc["locked"]:
        return _scanned(con, iid, sc, None, it, b, made)
    if sc["type"] == "zip" and sc.get("sub") == "archive" and not sc["hold"]:
        if depth >= ZIP_DEPTH:
            sc["refused"] = f"Zips packed {ZIP_DEPTH} deep or more aren't opened: that's how zip bombs are built."
            return _scanned(con, iid, sc, None, it, b, made)
        budget = budget if budget is not None else {"bytes": ZIP_TOTAL, "files": ZIP_MEMBERS}
        _put(con, iid, status="unpacked", type="zip", scan=sc, dest="Unpacked")
        made += _unzip(con, b, it, path, sc, budget, depth, ctx)
        _put(con, iid, scan=sc)
        con.commit()
        return made
    if (ext_of(base) == "eml" and sc["type"] in ("text", "xml")) or (sc["type"] == "ole" and ext_of(base) == "msg"):
        return _take_mail(con, b, it, path, sc, depth, budget, ctx, made)
    try:
        r = recognise(base, path, sc)
    except Exception as e:  # damaged in a way no reader expected: said, and on the pile
        sc["corrupt"] = f"RF Recon couldn't read this file ({type(e).__name__}). It may be damaged."
        r = None
    return _scanned(con, iid, sc, r, it, b, made)


def _scanned(con, iid, sc, r, it, b, made):
    r = r or {"kind": None, "conf": 0, "why": "", "facts": {}, "body": ""}
    status = "refused" if sc["refused"] else "reading" if sc["type"] == "pdf" and not (sc["corrupt"] or sc["locked"]) else "scanned"
    facts = {**(it.get("facts") or {}), **r["facts"]}
    _put(con, iid, type=sc["type"], scan=sc, kind=r["kind"], conf=r["conf"], why=r["why"], facts=facts, body=r["body"], status=status,
         problems=list(sc["problems"]))
    con.commit()
    return made


def _unzip(con, b, it, path, sc, budget, depth, ctx):
    made = []
    with zipfile.ZipFile(path) as z:
        for i in z.infolist():
            nm = i.filename.replace("\\", "/")
            base = nm.rsplit("/", 1)[-1]
            if i.is_dir() or JUNK.match(base) or "__MACOSX/" in nm:
                continue
            if budget["files"] <= 0 or budget["bytes"] < i.file_size:
                sc["problems"].append({"level": "bad", "text": "This zip held too much, so RF Recon stopped unpacking it part way."})
                break
            budget["files"] -= 1
            budget["bytes"] -= i.file_size
            tmp = os.path.join(stage_dir(), f"in-{threading.get_ident()}-{time.time_ns()}.part")
            h, got = hashlib.sha256(), 0
            try:
                with z.open(i) as src, open(tmp, "wb") as fh:
                    while True:
                        chunk = src.read(MB)
                        if not chunk:
                            break
                        got += len(chunk)
                        if got > i.file_size or got > MAX_FILE:
                            raise ValueError("bigger than it says")
                        h.update(chunk)
                        fh.write(chunk)
                made += _take(con, b, base, f"{it['path'] or it['name']}/{nm}", tmp, got, h.hexdigest(), ctx, it["id"], it["grp"] or it["name"], depth + 1, budget)
            except (zipfile.BadZipFile, ValueError, OSError, RuntimeError, zlib.error) as e:
                sc["problems"].append({"level": "bad", "text": f"{base} in this zip wouldn't unpack ({str(e)[:80]})."})
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
    return made


def _take_mail(con, b, it, path, sc, depth, budget, ctx, made):
    iid, name = it["id"], it["name"]
    with open(path, "rb") as fh:
        raw = fh.read()
    try:
        m = parse_msg(raw) if ext_of(name) == "msg" else parse_eml(raw)
    except (ValueError, struct.error, IndexError, KeyError, LookupError) as e:
        sc["corrupt"] = f"This email won't open ({str(e)[:80]})."
        return _scanned(con, iid, sc, None, it, b, made)
    if ext_of(name) == "eml" and not (m["subject"] or m["from"] or m["attachments"]):
        sc["hold"] = "Its name says .eml, but there's no email in it."
        return _scanned(con, iid, sc, None, it, b, made)
    facts = {"subject": m["subject"][:300], "from": m["from"], "from_name": m["from_name"][:120], "to": m["to"][:300], "date": m["date"][:60], "attachments": len(m["attachments"])}
    tag = re.search(r"\[RFR ([^\]]{1,60})\]", m["subject"])
    if tag:
        facts["tag"] = tag.group(1)
    body = f"{m['subject']}\n{m['text']}"[:TEXT_MAX]
    _scanned(con, iid, sc, {"kind": "email", "conf": .95, "why": "An email" + (f" from {m['from']}" if m["from"] else ""), "facts": facts, "body": body}, it, b, made)
    budget = budget if budget is not None else {"bytes": ZIP_TOTAL, "files": ZIP_MEMBERS}
    for a in m["attachments"]:
        if budget["files"] <= 0 or budget["bytes"] < len(a["data"]):
            break
        budget["files"] -= 1
        budget["bytes"] -= len(a["data"])
        an = clean_name(a["name"])
        if JUNK.match(an):
            continue
        hints = {"mail_from": m["from"]}
        if tag:
            hints["tag"] = tag.group(1)
        made += add_bytes(con, b["id"], a["name"], f"{name}/{an}", a["data"], ctx, iid, it["grp"] or name, depth + 1, budget, hints)
    return made


def read_pdf(con, iid, info, ctx):
    """What pdf.js found in the browser: {pages, sizes: [[w, h] in points], text, locked, broken}. The page reads it, this files it."""
    it = _get(con, iid, ctx)
    if it["type"] != "pdf":
        raise ValueError("That item isn't a PDF.")
    sc, f = it["scan"], dict(it["facts"])
    text = str(info.get("text") or "")[:TEXT_MAX]
    pages = int(info.get("pages") or 0)
    sizes = [x for x in (info.get("sizes") or []) if isinstance(x, list) and len(x) == 2][:80]
    f.update(pages=pages, sizes=sizes[:6])
    kind, conf, why, body = None, 0, "", text
    if info.get("locked"):
        sc["locked"] = "This PDF is locked with a password. RF Recon needs an unlocked copy."
    elif info.get("broken"):
        sc["corrupt"] = "This PDF is damaged and won't open."
    else:
        if sc.get("pdf_encrypted"):
            sc["problems"].append({"level": "info", "text": "This PDF is copy-protected. It opens, but RF Recon couldn't look inside its packed parts for code."})
        wide = bool(sizes) and max(max(s) for s in sizes[:12]) >= 1200   # 17 x 11 in and up: drawing sizes, not letters
        letter = bool(sizes) and max(max(s) for s in sizes[:12]) <= 800
        f.update(wide=wide)
        if len(re.sub(r"\s+", "", text)) < 30:
            kind, conf, why = "scan", 0, "No words on its pages"
            f["scan"] = True
        else:
            hay = f"{text}\n{it['name']}"
            seal = das.seal_of_pdf(con, text, pages, int(info.get("read") or 0), ctx.vis)
            if seal and not seal["ok"]:  # a code that doesn't hold up: a person looks, and it never counts as sealed
                sc["hold"] = seal["why"]
            k, score, w, tie = word_kind(hay, wide, letter)
            if seal and seal["ok"]:  # it files under its dated name, and the code decides the job. Only a checked code gets f["seal"]: das.sealed_files reads it
                kind, conf, why = "sealed_report", 1, f"Verify code {seal['code']}"
                f.update(seal=seal["code"], was=it["name"], plan="Goes in this job's AHJ packet, and is ticked when you email from the job. Nothing is sent.")
                _put(con, iid, name=clean_name(seal["file"]))
            elif seal and seal.get("job_name"):  # a real report that doesn't hold up: filed by hand it's a plain test report, and its job comes offered
                kind, conf, why = "test_report", .6, "A report whose verify code doesn't hold up"
                f["candidates"] = [{"id": seal["job_id"], "name": seal["job_name"]}]
            elif k and not tie:
                kind, conf, why = k, min(.95, .55 + score * .08), f"Words on the page: {w}"
            elif k:
                kind, conf, why = k, .5, f"Could be {label_of(k)} or {label_of(tie)}"
                f["maybe"] = [k, tie]
            else:
                kind, conf, why = "document", .6, "A PDF with words, none that mark it as one kind"
            if kind == "cal_cert":
                f.update(_cert_facts(text))
    addr = ADDRESS_RE.search(text)
    if addr:
        f["address"] = re.sub(r"\s+", " ", addr.group(0))[:120]
    _put(con, iid, scan=sc, facts=f, body=body, kind=kind, conf=conf, why=why, status="scanned", problems=list(sc["problems"]))
    con.commit()
    b = con.execute("SELECT * FROM intake_batch WHERE id=?", (it["batch_id"],)).fetchone()
    if b and b["done_at"]:  # the batch moved on without it (mail, or a page that was closed): it settles alone
        _finish(con, dict(b), ctx, only=iid)
    return public(con, _raw(con, iid))


def _seal_job(con, code):
    try:
        das._seal_table(con)
        r = con.execute("SELECT job_id FROM das_seal WHERE code=?", (das.seal_code_norm(code),)).fetchone()
    except Exception:
        return None
    return r["job_id"] if r else None


# ---------------------------------------------------------------- which job

ABBR = {"street": "st", "avenue": "ave", "boulevard": "blvd", "road": "rd", "drive": "dr", "lane": "ln", "court": "ct", "place": "pl", "parkway": "pkwy", "highway": "hwy",
        "north": "n", "south": "s", "east": "e", "west": "w", "circle": "cir"}
GENERIC = {"new job", "job", "test", "building", "office", "school", "hospital", "the building"}


def _words(s):
    return " ".join(ABBR.get(w, w) for w in re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).split())


def _addr_key(addr):
    a = _words(str(addr or "").split(",")[0])
    return a if re.match(r"\d+ \S+", a) and len(a) >= 7 else ""


def _jobs(con, ctx):
    """The jobs this login may open, each with what can point at it. A job it can't open is never named here (dashist.visible)."""
    out = []
    for r in con.execute("SELECT id, name, stage, data FROM das_job").fetchall():
        if ctx.vis is not None and r["id"] not in ctx.vis:
            continue
        d = json.loads(r["data"] or "{}")
        insts = (d.get("testing") or {}).get("instruments") or []
        out.append({"id": r["id"], "name": r["name"], "stage": r["stage"], "words": _words(r["name"]), "client": _words(d.get("client")), "addr": _addr_key(d.get("address")),
                    "lat": d.get("lat"), "lon": d.get("lon"), "serials": {str(i.get("serial")).lower() for i in insts if isinstance(i, dict) and i.get("serial")},
                    "calls": {str(x.get("call_sign")).upper() for x in ((d.get("presurvey") or {}).get("plan") or []) if isinstance(x, dict) and x.get("call_sign")}})
    return out


def _hav_mi(a, b, c, d):
    import math
    p1, p2 = math.radians(a), math.radians(c)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 2 * 3958.7613 * math.asin(min(1.0, math.sqrt(h)))


CERTAIN, STRONG, MEDIUM = 3, 2, 1


def signals(con, it, jobs):
    """What points at which job. [(job id, strength, why)]. Certain: the app's own tag, a verify code, a folder numbered for the job."""
    by = {j["id"]: j for j in jobs}
    f, body = it["facts"], it.get("body") or ""
    out = []
    add = lambda jid, s, why: out.append((jid, s, why)) if jid in by else None  # noqa: E731
    names = " ".join(str(x) for x in (it["name"], it.get("path"), f.get("subject"), f.get("tag")) if x)
    for m in re.finditer(r"\[RFR J(\d+)\b", names):
        add(int(m.group(1)), CERTAIN, f"Its RF Recon tag: J{m.group(1)}")
    m = re.match(r"J(\d+)\b", str(f.get("tag") or ""))
    if m:
        add(int(m.group(1)), CERTAIN, f"Its RF Recon tag: J{m.group(1)}")
    tag = re.search(r"\bQ(\d+)\.(\d+)\b", str(f.get("tag") or ""))
    if tag:
        r = con.execute("SELECT job_id FROM das_rfq WHERE id=?", (int(tag.group(1)),)).fetchone()
        if r and r["job_id"]:
            add(r["job_id"], CERTAIN, f"Its RF Recon tag: quote request {tag.group(1)}")
    if f.get("seal"):
        add(_seal_job(con, f["seal"]), CERTAIN, f"Verify code {f['seal']} is this job's sealed report")
    for seg in str(it.get("path") or "").replace("\\", "/").split("/") + [it["name"], it.get("grp") or ""]:
        m = re.match(r"(\d{4}) ", seg)
        if m:
            add(int(m.group(1)), CERTAIN, f'The folder or zip is numbered for this job: "{seg[:60]}"')
    hay = f" {_words(body)} {_words(names)} "
    for j in jobs:
        if j["addr"] and f" {j['addr']} " in hay:
            out.append((j["id"], STRONG, f"This job's address is in it: {j['addr']}"))
        if j["serials"] and f.get("serial") and str(f["serial"]).lower() in j["serials"]:
            out.append((j["id"], STRONG, f"Serial {f['serial']} is one of this job's instruments"))
        if it.get("kind") in ("consent", "rebroadcast") and j["calls"]:
            calls = sorted(c for c in j["calls"] if re.search(rf"\b{re.escape(c)}\b", body))
            if calls:
                out.append((j["id"], STRONG, f"Call sign {calls[0]} is on this job"))
        if j["words"] and len(j["words"]) >= 6 and j["words"] not in GENERIC and f" {j['words']} " in hay:
            out.append((j["id"], MEDIUM, f'The job\'s name is in it: "{j["name"][:50]}"'))
        elif j["client"] and len(j["client"]) >= 6 and j["client"] not in GENERIC and f" {j['client']} " in hay:
            out.append((j["id"], MEDIUM, f"The client's name is in it"))
        if f.get("lat") is not None and j["lat"] is not None:
            try:
                mi = _hav_mi(float(f["lat"]), float(f["lon"]), float(j["lat"]), float(j["lon"]))
                if mi <= .15:
                    out.append((j["id"], MEDIUM, f"Taken {mi:.2f} miles from this job's pin"))
            except (TypeError, ValueError):
                pass
    return out


def pick_job(sig, by, drop_job=None, group_job=None):
    """-> (job id or None, why, the others it could be). One job with one strong signal and nothing against it: filed, the reason shown.
    Signals that disagree: nobody guesses. Weak signals alone only suggest."""
    level = lambda n: {j for j, s, _ in sig if s >= n}  # noqa: E731
    why = lambda j, n: next(w for k, s, w in sorted(sig, key=lambda x: -x[1]) if k == j and s >= n)  # noqa: E731
    certain = level(CERTAIN)
    if len(certain) == 1:
        j = next(iter(certain))
        return j, why(j, CERTAIN), []
    if len(certain) > 1:
        return None, "", sorted(certain)
    strong = {j: why(j, STRONG) for j in level(STRONG)}
    if drop_job in by and drop_job not in strong:
        strong[drop_job] = "It was dropped on this job's page"
    if group_job in by and group_job not in strong:
        strong[group_job] = "The rest of its folder points at this job"
    if len(strong) == 1:
        j = next(iter(strong))
        return j, strong[j], []
    if len(strong) > 1:
        return None, "", sorted(strong)
    return None, "", sorted(level(MEDIUM))


# ---------------------------------------------------------------- is it good

def _assess(con, it, job):
    """The four checks every item gets (opens, belongs, complete, in date), and each problem in words. ok True, False, or None when it
    doesn't apply. Reading a certificate for what it doesn't say is the point: an expired one files, flagged, and never blocks."""
    k, f = it["kind"], it["facts"]
    d = (job or {}).get("data") or {}
    pages = f.get("pages")
    C = {"opens": [True, f"{pages} page{'' if pages == 1 else 's'}" if pages else ""], "belongs": [None, "No job picked yet"] if not job else [True, it.get("job_why") or job["name"]],
         "complete": [None, ""], "in_date": [None, ""]}
    P = []
    bad = lambda t: P.append({"level": "bad", "text": t})  # noqa: E731
    warn = lambda t: P.append({"level": "warn", "text": t})  # noqa: E731
    info = lambda t: P.append({"level": "info", "text": t})  # noqa: E731
    if k in FIRM_KINDS:
        C["belongs"] = [True, "Goes to the firm's own list, not a job"]
    if f.get("note"):
        info(f["note"])
    if k == "scan":
        C["complete"] = [False, "A scan has no words, so nothing in it could be read"]
    elif k == "cal_cert":
        miss = [w for w, key in (("serial number", "serial"), ("calibration date", "cal"), ("due date", "due")) if not f.get(key)]
        C["complete"] = [not miss, "Serial, calibration date and due date found" if not miss else f"Couldn't find its {' or '.join(miss)}"]
        if miss:
            warn(f"Couldn't find this certificate's {' or '.join(miss)}. Check them on the Overview tab.")
        insts = (d.get("testing") or {}).get("instruments") or []
        if job and f.get("serial"):
            ok = any(str(i.get("serial")).lower() == str(f["serial"]).lower() for i in insts if isinstance(i, dict))
            C["belongs"] = [ok, f"Serial {f['serial']} is on this job" if ok else f"Serial {f['serial']} isn't one of this job's instruments"]
            if not ok:
                warn(f"Serial {f['serial']} isn't one of this job's instruments. This may be the wrong certificate, or the instrument isn't listed yet.")
        if f.get("due"):
            left = days_to(f["due"])
            test = (d.get("testing") or {}).get("date")
            if left is not None and left < 0:
                C["in_date"] = [False, f"Expired {f['due']}"]
                bad(f"This certificate expired on {f['due']}.")
            elif test and test > f["due"]:
                C["in_date"] = [False, f"Runs out {f['due']}, before the test on {test}"]
                bad(f"This certificate runs out on {f['due']}, before the test date {test}.")
            elif left is not None and left <= 30:
                C["in_date"] = [True, f"Expires {f['due']}, in {left} days"]
                warn(f"This certificate expires in {left} days, on {f['due']}.")
            else:
                C["in_date"] = [True, f"Current to {f['due']}"]
    elif k == "plan_set":
        floors = d.get("floors") if isinstance(d.get("floors"), list) else []
        if not f.get("wide") and pages:
            info("These pages are letter size, small for drawings.")
        if job and floors and pages and pages < len(floors):
            C["complete"] = [False, f"{pages} page{'' if pages == 1 else 's'} for {len(floors)} floors"]
            warn(f"This set has {pages} page{'' if pages == 1 else 's'} and the job has {len(floors)} floors. A floor may be missing.")
        elif pages:
            C["complete"] = [True, f"{pages} page{'' if pages == 1 else 's'}"]
        if re.search(r"not for construction", it.get("body") or "", re.I):
            warn('These drawings say "not for construction".')
        info("The job's Plans tab reads this set's own words and proposes which page is which floor. You press to accept.")
    elif k == "spec_sheet":
        if re.search(r"ul\s*2524.{0,60}(2nd|second)\s+ed", it.get("body") or "", re.I | re.S):
            warn("This sheet cites UL 2524 2nd edition. Listings not updated to the 3rd edition by 2026-03-22 are withdrawn: check the listing.")
    elif k == "consent":
        C["complete"] = [None, "RF Recon can't tell if it says yes or no"]
        info("Read it: RF Recon can't tell whether this says yes or no, or whether it's signed.")
    elif k in ("permit", "maintenance", "rebroadcast", "sealed_drawings", "design_approval"):
        info("RF Recon can't tell whether this is signed.")
    elif k == "photo":
        if job and f.get("lat") is not None and d.get("lat") is not None:
            try:
                mi = _hav_mi(float(f["lat"]), float(f["lon"]), float(d["lat"]), float(d["lon"]))
                if mi > 1:
                    C["belongs"] = [False, f"Taken {mi:.1f} miles from this job's pin"]
                    warn(f"This photo was taken {mi:.1f} miles from this job's pin.")
            except (TypeError, ValueError):
                pass
        if f.get("when"):
            C["in_date"] = [None, f"Taken {f['when']}"]
    elif k == "email":
        C["complete"] = [True, f"From {f.get('from') or 'no sender'}, {f.get('attachments') or 0} attachment{'' if f.get('attachments') == 1 else 's'}"]
    elif k == "pattern" and f.get("bad"):
        C["opens"] = [False, f["bad"]]
        bad(f"This antenna pattern won't read: {f['bad']}")
    elif k == "sweep" and f.get("bad"):
        C["opens"] = [False, f["bad"]]
        bad(f"This sweep won't read: {f['bad']}")
    elif k in ("job_json",):
        info("Files aren't in a job export.")
    if f.get("rows") == 0:
        C["complete"] = [False, "Column names, but no rows"]
        bad("This has column names but no rows.")
    return C, P


# ---------------------------------------------------------------- filing: documents

def _log(con, jid, text):
    con.execute("INSERT INTO das_log(job_id, ts, kind, detail) VALUES(?,?,?,?)", (jid, das.now(), "intake", text[:2000]))


def _sha_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            b = fh.read(MB)
            if not b:
                return h.hexdigest()
            h.update(b)


def on_job(con, jid, jname, sha, size):
    """The file on this job with this content, or None: from the record, or else the disk (a file added another way has no record)."""
    known = dict(con.execute("SELECT name, sha256 FROM das_file WHERE job_id=?", (jid,)).fetchall())
    files = das.list_files(jid, jname)["files"]
    for f in files:
        if known.get(f["name"]) == sha:
            return f["name"]
    for f in files:
        if f["name"] not in known and f["size"] == size:
            try:
                if _sha_of(das.file_path(jid, jname, f["name"])) == sha:
                    return f["name"]
            except (OSError, ValueError):
                pass
    return None


def _save_in(con, it, jid, jname, kind, source="intake"):
    """The held file into the job's Files, and the record of what it is. Never over anything: das.save_path takes a free name."""
    name = it["name"]
    if not _safe_to_serve(name):  # the last door: job Files open in the browser
        raise PermissionError(f"{name} can't go in a job's Files.")
    saved = das.save_path(jid, jname, name, held(it["id"]))
    con.execute("INSERT OR REPLACE INTO das_file(job_id, name, sha256, kind, source, intake_id, at) VALUES(?,?,?,?,?,?,?)", (jid, saved, it["sha256"], kind, source, it["id"], das.now()))
    return saved


def _gone(it):
    try:
        os.remove(held(it["id"]))
    except OSError:
        pass


def _fill_cert(con, it, job, saved):
    """A certificate onto the instrument it names: its file and its expiry, each only where the job has none."""
    f = it["facts"]
    T = dict(job["data"].get("testing") or {})
    insts = [dict(i) if isinstance(i, dict) else i for i in T.get("instruments") or []]
    if not f.get("serial"):
        return None
    for i in insts:
        if isinstance(i, dict) and str(i.get("serial") or "").lower() == str(f["serial"]).lower():
            put = {}
            if not i.get("cert"):
                put["cert"] = saved
            if f.get("due") and not i.get("expires"):
                put["expires"] = f["due"]
            if f.get("cal") and not i.get("cal"):
                put["cal"] = f["cal"]
            if not put:
                return None
            i.update(put)
            T["instruments"] = insts
            das.save_job(con, {"data": {"testing": T}, "rev": job["rev"]}, job["id"], who=dashist.who_now(), note_=f"Intake: {saved} onto instrument {f['serial']}")
            return {"op": "inst", "job": job["id"], "serial": f["serial"], "put": put}
    return None


def _fill_spec(con, it):
    """A spec sheet onto the part it names, only when the part has none."""
    body = it.get("body") or ""
    hay = f" {_words(body[:40000])} {_words(it['name'])} "
    for r in con.execute("SELECT id, part, spec_file FROM das_part WHERE part IS NOT NULL AND part<>''").fetchall():
        w = _words(r["part"])
        if len(w) >= 4 and f" {w} " in hay:
            if r["spec_file"]:
                return None, r["part"]
            if it["size"] <= das.SPEC_MAX:
                with open(held(it["id"]), "rb") as fh:
                    das.save_spec(con, r["id"], fh.read())
                return {"op": "part_spec", "part": r["id"]}, r["part"]
    return None, None


def _file_doc(con, it, job, ctx, why=None):
    """A plain document onto a job, or onto a part when there's no job for it. -> nothing: the item is updated."""
    jid, kind = job["id"], it["kind"]
    dup = on_job(con, jid, job["name"], it["sha256"], it["size"])
    if dup:
        _put(con, it["id"], status="duplicate", job_id=jid, dest=f"Already on {job['name']} as {dup}. Not saved again.", done_at=das.now(), mark="duplicate")
        con.execute("INSERT OR IGNORE INTO das_file(job_id, name, sha256, kind, source, intake_id, at) VALUES(?,?,?,?,?,?,?)", (jid, dup, it["sha256"], kind, "found", it["id"], das.now()))
        return
    saved = _save_in(con, it, jid, job["name"], kind)
    ops = [{"op": "file", "job": jid, "name": saved}]
    note = f"{job['name']}, Files" + (f", as {saved}" if saved != it["name"] else "")
    extra = []
    if saved != it["name"]:
        extra.append({"level": "info", "text": f"A different file called {it['name']} was already on the job. Both are kept: this one is {saved}."})
    if kind == "cal_cert":
        op = _fill_cert(con, it, das.job_row(con, jid), saved)
        if op:
            ops.append(op)
            note += ", and onto its instrument"
    if kind == "spec_sheet":
        op, part = _fill_spec(con, it)
        if op:
            ops.append(op)
            note += f", and onto part {part}"
    _log(con, jid, f"Intake filed {saved} as {label_of(kind)}: {it.get('job_why') or ''}")
    probs = it["problems"] + extra
    _put(con, it["id"], status="filed", job_id=jid, dest=note, undo=ops, problems=probs, done_at=das.now(), facts={**it["facts"], "saved": saved},
         mark="scan: needs a person" if kind == "scan" else it.get("mark"))
    _gone(it)


def _fill_contacts(con, it, ctx):
    """New contacts, and blanks on those already kept. The duplicate rule is das.import_contacts': same email, or same name and organisation."""
    with open(held(it["id"]), "rb") as fh:
        raw = _utf8(fh.read())
    found = das.read_contacts(it["name"], raw)
    cs = das.list_contacts(con)
    by_em = {(c["email"] or "").strip().lower(): c for c in cs if c["email"]}
    by_key = {((c["name"] or "").lower(), (c["org"] or "").lower()): c for c in cs}
    added, filled, kept, ops = 0, 0, 0, []
    nomeans, bademail = [], []
    for c in found:
        em = (c.get("email") or "").strip().lower()
        key = ((c.get("name") or "").strip().lower(), (c.get("org") or "").strip().lower())
        if not any(key) and not em:
            continue
        who = c.get("name") or c.get("org") or em
        if not em and not (c.get("phone") or "").strip():
            nomeans.append(who)
        if em and not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,24}", em):
            bademail.append(f"{who} ({em})")
        old = by_em.get(em) if em else None
        old = old or (by_key.get(key) if any(key) else None)
        if old:
            put = {k: str(c[k]).strip() for k in das.CONTACT_FIELDS if str(c.get(k) or "").strip() and not str(old.get(k) or "").strip()}
            if put:
                con.execute(f"UPDATE das_contact SET {', '.join(k + '=?' for k in put)}, updated_at=? WHERE id=?", (*put.values(), das.now(), old["id"]))
                ops.append({"op": "contact_fill", "id": old["id"], "put": put})
                old.update(put)
                filled += 1
            else:
                kept += 1
            continue
        if not any(key):
            c["name"] = em.split("@")[0].replace(".", " ").replace("_", " ").title()
        row = das.save_contact(con, c)
        ops.append({"op": "contact_add", "id": row["id"], "stamp": row["updated_at"]})
        by_key[((row["name"] or "").lower(), (row["org"] or "").lower())] = dict(row)
        if em:
            by_em[em] = dict(row)
        added += 1
    probs = list(it["problems"])
    if nomeans:
        probs.append({"level": "warn", "text": f"{len(nomeans)} with no phone or email, so no way to reach them: {', '.join(nomeans[:6])}{'…' if len(nomeans) > 6 else ''}."})
    if bademail:
        probs.append({"level": "warn", "text": f"{len(bademail)} with an email that doesn't look right: {', '.join(bademail[:4])}{'…' if len(bademail) > 4 else ''}."})
    C, more = _assess(con, it, None)
    C["complete"] = [not nomeans, f"{len(found)} read, every one has a phone or an email" if not nomeans else f"{len(nomeans)} of {len(found)} can't be reached"]
    bits = [f"{added} added" if added else "", f"{filled} had blanks filled" if filled else "", f"{kept} already here, left as they are" if kept else ""]
    _put(con, it["id"], status="filed", dest="Contacts: " + (", ".join(b for b in bits if b) or "nothing new"), undo=ops, checks=C, problems=probs + more, done_at=das.now())
    con.commit()


# ---------------------------------------------------------------- deciding each item

def _names(con, ids):
    out = {}
    for i in ids:
        r = con.execute("SELECT name FROM das_job WHERE id=?", (i,)).fetchone()
        if r:
            out[i] = r["name"]
    return out


def _settle(con, it, jobs, sig, drop_job, group_job, ctx, force_job=None):
    """One scanned item: filed, held for a press, or on the pile, with its four checks and every problem said."""
    iid, kind, sc = it["id"], it["kind"], it["scan"]
    by = {j["id"]: j for j in jobs}
    facts = dict(it["facts"])
    guess = {"name": os.path.splitext(it["name"])[0][:80], "address": facts.get("address") or ""}
    facts["guess"] = guess

    def pile(mark, **kw):
        job = das.job_row(con, kw.get("job_id")) if kw.get("job_id") else None
        if kind == "scan":
            mark = f"scan: needs a person. {mark}"
        C, P = _assess(con, it, job)
        _put(con, iid, status="pile", mark=mark, facts=facts, checks=C, problems=it["problems"] + P, **kw)

    if sc.get("corrupt"):
        _put(con, iid, status="pile", mark=sc["corrupt"], checks={"opens": [False, ""]}, problems=it["problems"], facts=facts)
        return
    if sc.get("locked"):
        _put(con, iid, status="pile", mark=sc["locked"], checks={"opens": [False, ""]}, problems=it["problems"], facts=facts)
        return
    if sc.get("hold"):
        _put(con, iid, status="pile", mark=sc["hold"], checks={}, problems=it["problems"], facts=facts)
        return
    if not kind:
        return pile(facts.get("note") or facts.get("read_error") and f"Couldn't read it: {facts['read_error']}" or "RF Recon can't tell what this is.")
    info = KINDS[kind]
    if info["act"] == "own":
        return pile(f"{info['label']}: this has its own place. Bring it in on {info['home']}.")
    if facts.get("maybe") or facts.get("ask"):
        facts.setdefault("maybe", [kind])
        if not force_job and it.get("conf", 0) < 1:
            return pile(facts.get("ask") or f"This could be {' or '.join(label_of(k) for k in facts['maybe'][:3])}. Pick which.", job_id=force_job or drop_job)
    needs_job = kind not in FIRM_KINDS
    jid, why, others = (force_job, "You picked this job", []) if force_job else pick_job(sig, by, drop_job, group_job) if needs_job else (None, "", [])
    if needs_job and not jid and kind == "quote":
        jid, why, others = _quote_job(con, it, jobs, why, others)
    if needs_job and jid is None and kind == "spec_sheet":
        op, part = _fill_spec(con, it)
        if op:
            C, P = _assess(con, it, None)
            C["belongs"] = [True, f"Part {part} is in the catalogue"]
            _put(con, iid, status="filed", dest=f"Parts catalogue: spec sheet on {part}", undo=[op], checks=C, problems=it["problems"] + P, done_at=das.now())
            return
    if needs_job and jid is None:
        names = _names(con, others)
        facts["candidates"] = [{"id": i, "name": n} for i, n in names.items()]
        strong = len({j for j, s, _ in sig if s >= STRONG}) > 1 or (drop_job and any(j != drop_job for j, s, _ in sig if s >= STRONG))
        said = " and ".join(names.values())
        return pile(f"It points at two jobs: {said}. Pick one." if strong and len(names) > 1 else f"Might be {said}, but not sure enough to file it." if names else "No job to put it on. Pick one, or make a job from it.")
    if jid and not (by.get(jid) or {}):
        return pile("That job isn't one this login can open.")
    it["job_why"] = why
    job = das.job_row(con, jid) if jid else None
    if jid and ctx.gate:
        try:
            ctx.gate(jid, "edit")
        except (PermissionError, LookupError, dashist.NotAllowed):
            facts["candidates"] = [{"id": jid, "name": job["name"]}]
            return pile(f"This belongs on {job['name']}, which this login can look at but not change.", job_id=jid, job_why=why)
    C, P = _assess(con, it, job)
    it["problems"] = it["problems"] + P
    _put(con, iid, job_id=jid, job_why=why, checks=C, problems=it["problems"], facts=facts)
    it["facts"], it["job_id"] = facts, jid
    if not _safe_to_serve(it["name"]) and info["act"] == "file":
        return pile("This can't go in a job's Files, because a browser would run it.", job_id=jid, job_why=why)
    if info["act"] == "file":
        return _file_doc(con, it, job, ctx)
    if info["act"] == "fill":
        return _fill_contacts(con, it, ctx)
    plan = _plan(con, it, job)
    C["complete"] = plan.get("complete") or C["complete"]
    if plan.get("in_date"):
        C["in_date"] = plan["in_date"]
    if plan.get("block"):
        return pile(plan["block"], job_id=jid, job_why=why)
    facts.update(plan=plan.get("say") or "", needs=plan.get("needs") or [], rfq=plan.get("rfq"), suppliers=plan.get("suppliers"), insts=plan.get("insts"))
    _put(con, iid, status="waiting", job_id=jid, facts=facts, checks=C, problems=it["problems"] + (plan.get("problems") or []))


def _quote_job(con, it, jobs, why, others):
    """A quote's job is the request its lines match."""
    plan = _quote_match(con, it, {j["id"] for j in jobs})
    if plan:
        return plan["job_id"], f"Its parts match request {plan['rfq']}", []
    return None, why, others


def _finish(con, b, ctx, only=None):
    bid = b["id"]
    rows = [_row(r) for r in con.execute("SELECT * FROM intake_item WHERE batch_id=? AND status='scanned'" + (" AND id=?" if only else ""), (bid, *([only] if only else []))).fetchall()]
    hits = virus_pass([held(x["id"]) for x in rows if os.path.exists(held(x["id"]))])
    for it in rows:
        sc = it["scan"]
        if isinstance(hits, dict) and "error" in hits:
            sc["virus"] = f"{NOT_SCANNED} (the scanner failed: {hits['error']})"
        elif hits is not None:
            sig = hits.get(os.path.normpath(held(it["id"])))
            sc["virus"] = "virus-scanned, clean (ClamAV)"
            if sig:
                sc["virus"] = f"ClamAV found {sig}"
                sc["refused"] = f"The virus scanner flagged this: {sig}."
                _put(con, it["id"], status="refused", scan=sc)
                it["status"] = "refused"
                continue
        _put(con, it["id"], scan=sc)
    rows = [x for x in rows if x["status"] == "scanned"]
    jobs = _jobs(con, ctx)
    sigs = {it["id"]: signals(con, it, jobs) for it in rows}
    votes = {}
    for it in rows:   # a folder or a zip is one thing: most of it pointing at one job takes the rest along
        if it.get("grp"):
            best = {j for j, s, _ in sigs[it["id"]] if s >= STRONG}
            if len(best) == 1:
                votes.setdefault(it["grp"], {}).setdefault(next(iter(best)), 0)
                votes[it["grp"]][next(iter(best))] += 1
    group = {}
    for g, v in votes.items():
        top = max(v, key=v.get)
        if v[top] > sum(v.values()) * .6:
            group[g] = top
    for it in rows:
        try:
            _settle(con, it, jobs, sigs[it["id"]], b.get("job_id"), group.get(it.get("grp")), ctx)
        except PermissionError as e:
            _put(con, it["id"], status="pile", mark=str(e))
        except (OSError, ValueError, LookupError) as e:  # one bad item never stops the rest of the drop
            _put(con, it["id"], status="pile", mark=f"Couldn't file it: {str(e)[:160]}")
        con.commit()
    if not only:
        con.execute("UPDATE intake_batch SET done_at=? WHERE id=?", (das.now(), bid))
        con.commit()


def finish(con, bid, ctx):
    """Everything in the drop is in and read: decide each item. Safe to call twice."""
    b = _batch(con, bid, ctx)
    _finish(con, b, ctx)
    return batch_view(con, bid, ctx)


# ---------------------------------------------------------------- held for a press: what would change, and the press

def _has(v):
    return v is not None and v != ""


def _num(x):
    m = re.search(r"-?\d*\.?\d+", re.sub(r"[^\d.\-]", "", str(x if x is not None else "")))
    try:
        return float(m.group(0)) if m else None
    except ValueError:
        return None


def _readings_of(r):
    if not r:
        return []
    if isinstance(r.get("readings"), list):
        return r["readings"]
    return [r] if any(_has(r.get(k)) for k in ("dl", "daq", "sinr")) else []


def _ch_key(x):
    return "|".join(str(x.get(k) if x.get(k) is not None else "").strip().lower() for k in ("tech", "carrier", "freq", "pci"))


def grid_rows(name, data):
    """A results table as readings, the way the Grid test's own import maps it (das.js dasMapImport): -> ([(floor, square, reading, critical)], rows with no square)."""
    fmt, head, rows = das.read_table(name, data)
    m = das.guess_for(fmt, head)
    out, skipped = [], 0
    for r in rows:
        fl = str(r.get(m.get("floor"), "") or "").strip()
        g = re.sub(r"^(grid|area|square|cell)\s*#?\s*", "", str(r.get(m.get("grid"), "") or "").strip(), flags=re.I)
        g = re.sub(r"^[^-]+-(\d+)$", r"\1", g)
        if not g or not fl:
            skipped += 1
            continue
        o = {}
        for k in ("dl", "daq", "sinr", "ber", "ul", "ul_daq", "rsrp", "rsrq", "x", "y", "lat", "lon", "mhz"):
            if m.get(k):
                v = _num(r.get(m[k]))
                if v is not None:
                    o[k] = v
        for k in ("freq", "tech", "pci", "carrier", "band"):
            if m.get(k) and str(r.get(m[k]) or "").strip():
                o[k] = str(r[m[k]]).strip()
        if m.get("note") and r.get(m["note"]):
            o["note"] = str(r[m["note"]])
        if m.get("time") and r.get(m["time"]):
            o["time"] = str(r[m["time"]])
        out.append((fl, g, o, str(r.get(m.get("critical"), "") or "").strip()))
    return out, skipped


def grid_plan(job, name, data):
    """What pressing Apply would do to this job, and what it would leave alone. Readings go in only where that square has nothing on that channel."""
    d = job["data"]
    res = (d.get("grid") or {}).get("results") or {}
    rows, skipped = grid_rows(name, data)
    have = {f.get("name") for f in (d.get("floors") or []) if isinstance(f, dict)}
    adds, keeps, seen_new = [], 0, set()
    for fl, g, o, crit in rows:
        k = f"{fl}|{g}"
        ck = _ch_key(o)
        if ck in {_ch_key(x) for x in _readings_of(res.get(k))}:
            keeps += 1
            continue
        adds.append((k, fl, g, o, crit))
        seen_new.add(fl)
    return {"adds": adds, "keeps": keeps, "skipped": skipped, "new_floors": sorted(x for x in {a[1] for a in adds} if x not in have), "floors": sorted(seen_new), "total": len(rows)}


def _plan(con, it, job):
    """The sentence a person reads before pressing, and anything the press still needs."""
    k = it["kind"]
    f = it["facts"]
    with open(held(it["id"]), "rb") as fh:
        raw = _utf8(fh.read()) if os.path.getsize(held(it["id"])) <= TABLE_MAX else b""
    if k == "grid":
        d = job["data"]
        p = grid_plan(job, it["name"], raw)
        if not p["total"]:
            return {"block": "No rows with a floor and a square could be read."}
        bits = [f"Adds {len(p['adds'])} reading{'' if len(p['adds']) == 1 else 's'} to floor{'' if len(p['floors']) == 1 else 's'} {', '.join(p['floors'][:6])}" if p["adds"] else "No new readings"]
        if p["keeps"]:
            bits.append(f"{p['keeps']} already on file stay as they are")
        if p["new_floors"]:
            bits.append(f"adds floor{'' if len(p['new_floors']) == 1 else 's'} {', '.join(p['new_floors'][:6])}")
        if p["skipped"]:
            bits.append(f"{p['skipped']} rows have no floor or square and are left out")
        problems = []
        if p["keeps"]:
            problems.append({"level": "info", "text": f"{p['keeps']} reading{' is' if p['keeps'] == 1 else 's are'} already on file for that channel. Those stay."})
        if p["skipped"]:
            problems.append({"level": "warn", "text": f"{p['skipped']} rows have no floor or square, so they can't go in."})
        out = {"say": ". ".join(bits) + ".", "problems": problems, "complete": [not p["skipped"], f"{p['total'] - p['skipped']} of {p['total']} rows placed"]}
        inst = (d.get("grid") or {}).get("inst")
        insts = [i for i in (d.get("testing") or {}).get("instruments") or [] if isinstance(i, dict)]
        if not inst:
            out["needs"] = ["inst"]
            out["insts"] = [{"key": f"{i.get('model')}|{i.get('serial') or ''}", "name": " ".join(str(x) for x in (i.get("model"), i.get("serial")) if x)} for i in insts] + [{"key": "uncal", "name": "Not calibrated (pre-survey, won't count)"}]
            problems.append({"level": "warn", "text": "Say what took these readings before they go in: a reading with no instrument can't count."})
        else:
            i = next((x for x in insts if f"{x.get('model')}|{x.get('serial') or ''}" == inst), None)
            due = (i or {}).get("expires")
            late = sum(1 for a in p["adds"] if due and to_date(str(a[3].get("time") or "")[:10]) > due) if i else 0
            if late:
                out["in_date"] = [False, f"{late} taken after calibration ran out on {due}"]
                problems.append({"level": "bad", "text": f"{late} readings were taken after the instrument's calibration ran out on {due}. They won't count."})
        return out
    if k == "sweep":
        n = f.get("points")
        return {"say": f"Adds one sweep of {n} points to the job, and keeps the export in Files.", "complete": [True, f"{n} points"]}
    if k in ("walk", "compass", "noise", "gain"):
        rows = f.get("rows")
        tab = {"walk": "Grid test", "compass": "Grid test", "noise": "Commissioning", "gain": "Commissioning"}[k]
        return {"say": f"Keeps this in the job's Files. Its {rows or ''} rows go in from the {tab} tab, where you say where and when they were taken.".replace("  ", " "), "complete": [None, ""]}
    if k == "price_list":
        p = parts_plan(con, it["name"], raw, f.get("supplier") or "")
        bits = [f"Adds {len(p['new'])} part{'' if len(p['new']) == 1 else 's'}" if p["new"] else "No new parts"]
        if p["fill"]:
            bits.append(f"fills {len(p['fill'])} blank{'' if len(p['fill']) == 1 else 's'}")
        if p["moved"]:
            bits.append(f"{len(p['moved'])} price{' differs and stays as it is' if len(p['moved']) == 1 else 's differ and stay as they are'}")
        probs = []
        if p["moved"]:
            ex = p["moved"][0]
            probs.append({"level": "warn", "text": f"{len(p['moved'])} price{' differs' if len(p['moved']) == 1 else 's differ'} from the catalogue (e.g. {ex['part']}: {ex['old']} here, {ex['new']} in the file). Intake never replaces a price: use the price list import in Materials to do that."})
        if p["no_price"]:
            probs.append({"level": "warn", "text": f"{p['no_price']} of {p['rows']} rows have no price."})
        out = {"say": ". ".join(bits) + ".", "problems": probs, "complete": [not p["no_price"], f"{p['rows'] - p['no_price']} of {p['rows']} rows have a price"]}
        if not p["supplier"]:
            out["needs"] = ["supplier"]
        return out
    if k == "quote":
        q = _quote_match(con, it, None)
        if not q:
            return {"block": "This looks like a supplier's quote, but its parts match no open request."}
        out = {"say": f"Adds {q['matched']} quoted lines to request {q['rfq']}. A line that supplier has already quoted stays as it is.", "rfq": q["rfq"], "suppliers": q["suppliers"],
               "complete": [q["matched"] == q["asked"], f"{q['matched']} of {q['asked']} lines quoted"]}
        if q.get("supplier"):
            out["supplier"] = q["supplier"]
            it["facts"]["supplier"] = q["supplier"]
        else:
            out["needs"] = ["supplier"]
        return out
    if k == "pattern":
        r = con.execute("SELECT id, pattern FROM das_part WHERE part=? OR key=?", (f.get("antenna"), das._part_key(f.get("antenna"), ""))).fetchone()
        if r and r["pattern"]:
            return {"block": f"{f.get('antenna')} already has a pattern, and Intake never replaces one. Use the part's own Pattern button to do that."}
        return {"say": f"Puts this pattern on part {f.get('antenna')}." if r else f"Adds antenna {f.get('antenna')} to the parts catalogue, with this pattern.", "complete": [True, "360 points in both cuts"]}
    if k == "capture":
        return {"say": "Adds this to the active mission as a new capture." if _active_mission(con) else "Adds this as a new capture, on no mission (none is active).", "complete": [True, f"{f.get('rows') or ''} rows".strip()] if f.get("rows") else [None, ""]}
    if k == "layer":
        return {"say": f"Adds this as a new map layer called {_layer_name(it)}. No layer already here is touched."}
    return {"say": ""}


def _active_mission(con):
    r = con.execute("SELECT v FROM setting WHERE k='active_mission'").fetchone() if con.execute("SELECT 1 FROM sqlite_master WHERE name='setting'").fetchone() else None
    return r["v"] if r else None


def _layer_name(it):
    return f"{os.path.splitext(it['name'])[0][:60]} (Intake {it['id']})"  # always a new name: the same name deletes the old layer (connectors.import_custom)


def parts_plan(con, name, raw, supplier=""):
    """What a price list would add, fill and leave alone. The same rows das.import_parts reads."""
    _, head, rows = das.read_table(name, raw)
    m = das.guess_mapping(head, das.PART_ALIASES)
    new, fill, moved, no_price, seen, sup_used = [], [], [], 0, set(), ""
    for r in rows:
        x = {f: str(r.get(h) if r.get(h) is not None else "").strip() for f, h in m.items()}
        part, item = x.get("part", ""), x.get("item", "")
        if not part and not item:
            continue
        sup = (supplier or x.get("supplier") or "").strip()
        sup_used = sup_used or sup
        key = das._part_key(part, item)
        if (sup, key) in seen:
            continue
        seen.add((sup, key))
        price = das._price(x.get("price"))
        no_price += price is None
        old = con.execute("SELECT * FROM das_part WHERE supplier=? AND key=?", (sup, key)).fetchone()
        if not old:
            new.append({"supplier": sup, "key": key, "part": part, "item": item, "maker": x.get("maker", ""), "cat": x.get("cat", ""), "unit": x.get("unit", ""), "price": price,
                        "spec_url": x.get("spec_url", ""), "weight_lb": das._price(x.get("weight_lb"))})
            continue
        put = {k: v for k, v in (("item", item), ("maker", x.get("maker")), ("cat", x.get("cat")), ("unit", x.get("unit")), ("spec_url", x.get("spec_url"))) if v and not old[k]}
        if price is not None and old["price"] is None:
            put["price"] = price
        if put:
            fill.append({"id": old["id"], "put": put})
        if price is not None and old["price"] is not None and abs(price - old["price"]) > .004:
            moved.append({"part": part or item, "old": old["price"], "new": price})
    return {"new": new, "fill": fill, "moved": moved, "no_price": int(no_price), "rows": len(seen), "supplier": sup_used}


def _quote_match(con, it, vis):
    with open(held(it["id"]), "rb") as fh:
        raw = _utf8(fh.read())
    _, head, rows = das.read_table(it["name"], raw)
    m = das.guess_mapping(head, das.QUOTE_ALIASES)
    keys = {das._part_key(str(r.get(m.get("part"), "") or ""), str(r.get(m.get("item"), "") or "")) for r in rows} | {das._part_key("", str(r.get(m.get("item"), "") or "")) for r in rows}
    best = None
    tag = re.search(r"\bQ(\d+)\.(\d+)\b", str(it["facts"].get("tag") or ""))
    for r in con.execute("SELECT id, job_id, lines, suppliers FROM das_rfq ORDER BY id DESC").fetchall():
        if vis is not None and r["job_id"] not in vis:
            continue
        lines = [x["key"] for x in json.loads(r["lines"] or "[]")]
        hit = len(keys & set(lines))
        forced = bool(tag and int(tag.group(1)) == r["id"])
        if (hit or forced) and (best is None or hit > best["matched"] or forced):
            sups = json.loads(r["suppliers"] or "[]")
            best = {"rfq": r["id"], "job_id": r["job_id"], "matched": hit, "asked": len(lines), "suppliers": sups}
            if forced and 1 <= int(tag.group(2)) <= len(sups):
                best["supplier"] = sups[int(tag.group(2)) - 1]
            elif len(sups) == 1:
                best["supplier"] = sups[0]
            frm = it["facts"].get("mail_from")
            if frm:
                for s in sups:
                    e = con.execute("SELECT email FROM das_supplier WHERE name=?", (s,)).fetchone()
                    if e and (e["email"] or "").lower() == frm:
                        best["supplier"] = s
    return best


def _keep_copy(con, it, job, kind=None):
    dup = on_job(con, job["id"], job["name"], it["sha256"], it["size"])
    if dup:
        return dup, []
    saved = _save_in(con, it, job["id"], job["name"], kind or it["kind"])
    return saved, [{"op": "file", "job": job["id"], "name": saved}]


def _apply_grid(con, it, job, body, ctx):
    with open(held(it["id"]), "rb") as fh:
        raw = _utf8(fh.read())
    d = job["data"]
    G = dict(d.get("grid") or {})
    inst = str(body.get("inst") or G.get("inst") or "").strip()
    if not inst:
        raise ValueError("Say what took these readings first.")
    p = grid_plan(job, it["name"], raw)
    res = dict(G.get("results") or {})
    at = das.now()
    for k, fl, g, o, crit in p["adds"]:
        rs = list(_readings_of(res.get(k)))
        rs.append({**o, "time": o.get("time") or at, "source": it["name"], "inst": inst, "intake": it["id"]})
        res[k] = {"readings": rs}
    floors = [dict(x) if isinstance(x, dict) else x for x in (d.get("floors") if isinstance(d.get("floors"), list) else [])]
    added = [{"name": x, "grids": 20} for x in p["new_floors"]]
    floors += added
    crit_added = {}
    for k, fl, g, o, crit in p["adds"]:
        if re.fullmatch(r"(?i)1|y|yes|true|critical", crit):
            num = int(g) if str(g).isdigit() else g
            for x in floors:
                if isinstance(x, dict) and x.get("name") == fl and num not in (x.get("critical") or []):
                    x["critical"] = [*(x.get("critical") or []), num]
                    crit_added.setdefault(fl, []).append(num)
    G["results"] = res
    das.save_job(con, {"data": {"grid": G, "floors": floors}, "rev": job["rev"]}, job["id"], who=ctx.by, note_=f"Intake: {len(p['adds'])} readings from {it['name']}")
    saved, ops = _keep_copy(con, it, das.job_row(con, job["id"]))
    ops = [*ops, {"op": "grid", "job": job["id"], "floors": [x["name"] for x in added], "critical": crit_added}]
    return f"{job['name']}, Grid test: {len(p['adds'])} readings added" + (f", {p['keeps']} already on file left as they were" if p["keeps"] else ""), ops


def _apply_sweep(con, it, job, body, ctx):
    with open(held(it["id"]), "rb") as fh:
        raw = fh.read()
    t = das.read_sweep(it["name"], raw)
    s = t["series"][0]
    kind = "dtf" if t["x_kind"] == "dist" else s.get("kind") or "rl"
    x, y = list(t["x"]), list(s["y"])
    if len(x) > 2000:  # dassweep.js SW_MAX: a job doesn't carry 20,000 points. Each bucket keeps its worst reading
        worse = (lambda a, b: a < b) if kind in ("rl", "dtf") else (lambda a, b: a > b)
        ox, oy, n = [], [], len(x)
        for b in range(2000):
            i0, i1 = b * n // 2000, (b + 1) * n // 2000
            k = i0
            for i in range(i0, i1):
                if y[i] is not None and (y[k] is None or worse(y[i], y[k])):
                    k = i
            ox.append(x[k])
            oy.append(y[k])
        x, y = ox, oy
    saved, ops = _keep_copy(con, it, job)
    run = {"kind": kind, "where": os.path.splitext(it["name"])[0], "x_unit": t["x_unit"], "x": x, "y": y, "id": int(time.time() * 1000), "file": saved, "instrument": t["instrument"] or "",
           "date": t["date"] or "", "series": s["name"], "at": time.strftime("%Y-%m-%dT%H:%M"), "by": ctx.by, "f_lo": None, "f_hi": None, "ignore_past_ft": None, "intake": it["id"]}
    if kind == "il":
        run["il"] = {"connectors": 2, "tol_db": .5}
    else:
        run["limit"] = {"preset": "common"}
    job = das.job_row(con, job["id"])
    sw = dict(job["data"].get("sweeps") or {})
    sw["runs"] = [*(sw.get("runs") or []), run]
    das.save_job(con, {"data": {"sweeps": sw}, "rev": job["rev"]}, job["id"], who=ctx.by, note_=f"Intake: sweep from {it['name']}")
    return f"{job['name']}, Sweeps: 1 added, export in Files", [*ops, {"op": "sweep", "job": job["id"]}]


def _apply_price(con, it, job, body, ctx):
    with open(held(it["id"]), "rb") as fh:
        raw = _utf8(fh.read())
    p = parts_plan(con, it["name"], raw, str(body.get("supplier") or it["facts"].get("supplier") or "").strip())
    ops = []
    for x in p["new"]:
        cur = con.execute("INSERT INTO das_part(supplier, key, part, item, maker, cat, unit, price, spec_url, weight_lb, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                          (x["supplier"], x["key"], x["part"], x["item"], x["maker"], x["cat"], x["unit"], x["price"], x["spec_url"], x["weight_lb"], das.now()))
        ops.append({"op": "part_add", "id": cur.lastrowid})
    for x in p["fill"]:
        con.execute(f"UPDATE das_part SET {', '.join(k + '=?' for k in x['put'])}, updated_at=? WHERE id=?", (*x["put"].values(), das.now(), x["id"]))
        ops.append({"op": "part_fill", "id": x["id"], "put": x["put"]})
    con.commit()
    return f"Parts catalogue: {len(p['new'])} added, {len(p['fill'])} blanks filled, {len(p['moved'])} prices left as they were", ops


def _apply_quote(con, it, job, body, ctx):
    q = _quote_match(con, it, None)
    sup = str(body.get("supplier") or it["facts"].get("supplier") or "").strip()
    if not q or sup not in q["suppliers"]:
        raise ValueError("Say which supplier sent this quote.")
    with open(held(it["id"]), "rb") as fh:
        raw = _utf8(fh.read())
    r = das.import_quote(con, q["rfq"], sup, it["name"], raw, only_new=True)
    n = r["imported"]
    return f"Request {q['rfq']}: {n['lines']} lines from {sup}" + (f", {len(n['kept'])} already quoted left as they were" if n["kept"] else ""), [{"op": "quote", "rfq": q["rfq"], "supplier": sup, "keys": n["keys"]}]


def _apply_pattern(con, it, job, body, ctx):
    with open(held(it["id"]), "rb") as fh:
        raw = fh.read()
    f = it["facts"]
    r = con.execute("SELECT id, pattern FROM das_part WHERE part=? OR key=?", (f.get("antenna"), das._part_key(f.get("antenna"), ""))).fetchone()
    if r and r["pattern"]:
        raise ValueError(f"{f.get('antenna')} already has a pattern. Intake never replaces one.")
    p = das.save_pattern(con, r["id"] if r else None, it["name"], raw)
    return f"Parts catalogue: pattern on {p.get('part')}", [{"op": "part_add" if not r else "part_pattern", "id": p["id"]}]


def _apply_capture(con, it, job, body, ctx):
    with open(held(it["id"]), "rb") as fh:
        raw = fh.read()
    s = ctx.capture(it["name"], raw)
    return f"Capture: {s.get('points', 0)} points, {s.get('dropped', {}) and 'some dropped' or 'none dropped'}", [{"op": "capture", "id": s.get("capture_id")}]


def _apply_layer(con, it, job, body, ctx):
    with open(held(it["id"]), "rb") as fh:
        raw = fh.read()
    name = _layer_name(it)
    n = ctx.layer(name, it["name"], raw)
    return f"Map layer {name}: {n} points", [{"op": "layer", "name": name}]


APPLY = {"grid": _apply_grid, "sweep": _apply_sweep, "price_list": _apply_price, "quote": _apply_quote, "pattern": _apply_pattern, "capture": _apply_capture, "layer": _apply_layer}


def apply_item(con, iid, body, ctx):
    """The one press. Readings and prices go in here and nowhere else, and only into empty spots."""
    it = _get(con, iid, ctx)
    if it["status"] != "waiting":
        raise ValueError("This isn't waiting for a press.")
    kind, jid = it["kind"], it["job_id"]
    job = None
    if jid:
        ctx.gate(jid, "edit")
        job = das.job_row(con, jid)
        if not job:
            raise LookupError("That job was deleted.")
    if kind in PRESS_TO_TAB:
        saved, ops = _keep_copy(con, it, job)
        dest = f"{job['name']}, Files: {saved}"
    else:
        try:
            dest, ops = APPLY[kind](con, it, job, body or {}, ctx)
        except ValueError:
            raise
    if jid:
        _log(con, jid, f"Intake applied {it['name']}: {dest}")
    _put(con, iid, status="applied", dest=dest, undo=ops, done_at=das.now())
    if any(o["op"] == "file" for o in ops):
        _gone(it)
    con.commit()
    return public(con, _raw(con, iid))


def apply_batch(con, bid, ctx):
    """Apply all the sure ones: every waiting item in the drop that needs no further answer. One press, per the brief."""
    _batch(con, bid, ctx)
    done, left = 0, []
    for r in con.execute("SELECT id, name, facts FROM intake_item WHERE batch_id=? AND status='waiting' ORDER BY id", (bid,)).fetchall():
        if (json.loads(r["facts"] or "{}").get("needs")):
            left.append(r["name"])
            continue
        try:
            apply_item(con, r["id"], {}, ctx)
            done += 1
        except (ValueError, LookupError) as e:
            left.append(f"{r['name']}: {e}")
    out = batch_view(con, bid, ctx)
    out.update(applied=done, left=left)
    return out


def keep_item(con, iid, ctx, jid=None):
    """Keep in Files only: the file goes on the job, nothing in it does. A locked file can: it just can't be read."""
    it = _get(con, iid, ctx)
    if it["status"] not in ("waiting", "pile") or it["scan"].get("refused"):
        raise ValueError("This can't be kept in Files.")
    if it["scan"].get("hold") or it["scan"].get("corrupt"):
        raise ValueError("This can't go in Files until someone has looked at it.")
    jid = int(jid) if jid else it["job_id"]
    if not jid:
        raise ValueError("Pick a job first.")
    ctx.gate(jid, "edit")
    job = das.job_row(con, jid)
    if not _safe_to_serve(it["name"]):
        raise ValueError("This can't go in a job's Files, because a browser would run it.")
    saved, ops = _keep_copy(con, it, job)
    _log(con, jid, f"Intake kept {saved} in Files")
    _put(con, iid, status="kept", dest=f"{job['name']}, Files only: {saved}", undo=ops, done_at=das.now())
    if ops:
        _gone(it)
    con.commit()
    return public(con, _raw(con, iid))


def move_item(con, iid, jid, ctx, kind=None):
    """A person says which job, and or what it is. A filed item comes back off the old job first."""
    it = _get(con, iid, ctx)
    if it["scan"].get("refused"):
        raise ValueError("A refused file stays refused.")
    if it["scan"].get("corrupt"):
        raise ValueError("This file is damaged, so it can't be filed. Get a good copy and drop that.")
    if it["scan"].get("locked"):
        raise ValueError("This file is locked. Keep it in Files, or drop an unlocked copy.")
    if kind and kind not in PICKABLE:
        raise ValueError("That isn't a kind Intake files.")
    jid = int(jid) if jid not in (None, "") else None
    if jid is not None:
        ctx.gate(jid, "edit")
    if it["status"] in ("filed", "applied", "kept"):
        _undo(con, it, ctx)
        it = _raw(con, iid)
    if it["status"] not in ("pile", "waiting", "undone"):
        raise ValueError("This can't be moved now.")
    if not os.path.exists(held(iid)):
        raise ValueError("The held copy of this file has been cleared.")
    if it["scan"].get("hold"):  # a person has looked at it and says it's fine: said in the ledger, and the warning stays on the item
        sc = dict(it["scan"])
        sc["problems"] = [*sc["problems"], {"level": "warn", "text": f"Filed by {ctx.by} after this warning: {sc['hold']}"}]
        sc["hold"] = None
        _put(con, iid, scan=sc)
    facts = dict(it["facts"])
    for k in ("maybe", "ask", "candidates", "plan", "needs"):
        facts.pop(k, None)
    if kind:
        _put(con, iid, kind=kind, conf=1, why="You picked this", facts=facts, status="scanned")
        if kind == "cal_cert" and it.get("body"):
            facts.update(_cert_facts(it["body"]))
            _put(con, iid, facts=facts)
    else:
        _put(con, iid, facts=facts, status="scanned")
    it = _raw(con, iid)
    it["problems"] = list(it["scan"].get("problems") or [])
    jobs = _jobs(con, ctx)
    if jid and not any(j["id"] == jid for j in jobs):
        raise LookupError("No such job.")
    try:
        _settle(con, it, jobs, signals(con, it, jobs), None, None, ctx, force_job=jid)
    except PermissionError as e:
        _put(con, iid, status="pile", mark=str(e))
    con.commit()
    return public(con, _raw(con, iid))


def new_job_for(con, iid, d, ctx):
    """Make a job from what the file says. An existing job is never touched."""
    it = _get(con, iid, ctx)
    name = str((d or {}).get("name") or it["facts"].get("guess", {}).get("name") or it["name"]).strip()[:120]
    addr = str((d or {}).get("address") or it["facts"].get("guess", {}).get("address") or "").strip()[:200]
    j = das.save_job(con, {"name": name, "data": {"address": addr} if addr else {}})
    return move_item(con, iid, j["id"], Ctx(con, ctx.who, ctx.role, ctx.gate, ctx.capture, ctx.layer, ctx.unlayer, ctx.uncapture))


def drop_item(con, iid, ctx):
    it = _get(con, iid, ctx)
    if it["status"] in ("filed", "applied", "kept"):
        raise ValueError("Undo it first.")
    _gone(it)
    _put(con, iid, status="dropped", dest="Thrown away", done_at=das.now(), body=None)
    con.commit()
    return {"ok": True}


# ---------------------------------------------------------------- undo

class Busy(Exception):
    """The filing's result has been used since: the page asks before going on."""


def _strip(d, op, iid):
    """The job's data with this filing's own marks taken out. Only those: anything a person added since stays."""
    d = copy.deepcopy(d)
    if op["op"] == "grid":
        G = d.get("grid") or {}
        res = {}
        for k, r in (G.get("results") or {}).items():
            if isinstance(r, dict) and isinstance(r.get("readings"), list):
                keep = [x for x in r["readings"] if not (isinstance(x, dict) and x.get("intake") == iid)]
                if keep:
                    res[k] = {**r, "readings": keep}
            else:
                res[k] = r
        G["results"] = res
        d["grid"] = G
        fl = [x for x in (d.get("floors") if isinstance(d.get("floors"), list) else [])]
        crit = op.get("critical") or {}
        for x in fl:
            if isinstance(x, dict) and x.get("name") in crit:
                x["critical"] = [c for c in x.get("critical") or [] if c not in crit[x["name"]]]
        drop = set(op.get("floors") or [])
        used = {k.split("|")[0] for k in res}
        d["floors"] = [x for x in fl if not (isinstance(x, dict) and x.get("name") in drop and x.get("name") not in used and not x.get("plan"))]
    elif op["op"] == "sweep":
        sw = d.get("sweeps") or {}
        sw["runs"] = [r for r in sw.get("runs") or [] if not (isinstance(r, dict) and r.get("intake") == iid)]
        d["sweeps"] = sw
    elif op["op"] == "inst":
        T = d.get("testing") or {}
        for i in T.get("instruments") or []:
            if isinstance(i, dict) and str(i.get("serial") or "").lower() == str(op["serial"]).lower():
                for k, v in op["put"].items():
                    if i.get(k) == v:
                        i.pop(k, None)
        d["testing"] = T
    return d


JOB_OPS = ("grid", "sweep", "inst")


def _undo(con, it, ctx, force=False):
    """The filing's steps taken back, newest first. A step whose result someone has changed since is left, and said."""
    iid, ops, left = it["id"], it["undo"], []
    jid = next((o["job"] for o in ops if o.get("job")), None) or it["job_id"]
    job = das.job_row(con, jid) if jid else None
    files = [o for o in ops if o["op"] == "file"]
    if files and not job:
        raise LookupError("That job was deleted, so there's nothing to undo.")
    if job:
        ctx.gate(jid, "edit")
        data = job["data"]
        for o in ops:
            if o["op"] in JOB_OPS:
                data = _strip(data, o, iid)
        for o in files:
            if not force and o["name"] in json.dumps(data, ensure_ascii=False):
                raise Busy(f"{o['name']} is in use on this job now (a floor plan, a certificate, a report). Undo anyway?")
        changed = {k: v for k, v in data.items() if job["data"].get(k) != v}
        if changed:
            das.save_job(con, {"data": changed, "rev": job["rev"]}, jid, who=ctx.by, note_=f"Intake: undid {it['name']}")
    for o in reversed(ops):
        op = o["op"]
        if op == "file":
            fp = das.file_path(jid, job["name"], o["name"])
            if os.path.isfile(fp):
                shutil.move(fp, held(iid))   # Intake's own trash: the file comes back here, and can be filed again
            else:
                left.append(f"{o['name']} had already been deleted from the job")
            con.execute("DELETE FROM das_file WHERE job_id=? AND name=?", (jid, o["name"]))
        elif op == "contact_add":
            r = con.execute("SELECT updated_at, name FROM das_contact WHERE id=?", (o["id"],)).fetchone()
            if r and r["updated_at"] == o["stamp"]:
                con.execute("DELETE FROM das_contact WHERE id=?", (o["id"],))
            elif r:
                left.append(f"{r['name']} was changed since, so it stays")
        elif op == "contact_fill":
            r = con.execute("SELECT * FROM das_contact WHERE id=?", (o["id"],)).fetchone()
            for k, v in o["put"].items():
                if r and r[k] == v:
                    con.execute(f"UPDATE das_contact SET {k}='' WHERE id=?", (o["id"],))
        elif op == "part_add":
            con.execute("DELETE FROM das_part WHERE id=?", (o["id"],))
        elif op == "part_fill":
            r = con.execute("SELECT * FROM das_part WHERE id=?", (o["id"],)).fetchone()
            for k, v in o["put"].items():
                if r and r[k] == v:
                    con.execute(f"UPDATE das_part SET {k}=NULL WHERE id=?", (o["id"],))
        elif op == "part_pattern":
            con.execute("UPDATE das_part SET pattern=NULL WHERE id=?", (o["id"],))
        elif op == "part_spec":
            r = con.execute("SELECT spec_file FROM das_part WHERE id=?", (o["part"],)).fetchone()
            if r and r["spec_file"]:
                fp = os.path.join(das.spec_dir(False), r["spec_file"])
                if os.path.isfile(fp):
                    os.remove(fp)
                con.execute("UPDATE das_part SET spec_file=NULL WHERE id=?", (o["part"],))
        elif op == "quote":
            for k in o["keys"]:
                con.execute("DELETE FROM das_quote WHERE rfq_id=? AND supplier=? AND key=?", (o["rfq"], o["supplier"], k))
        elif op == "capture" and ctx.uncapture:
            ctx.uncapture(o["id"])
        elif op == "layer" and ctx.unlayer:
            ctx.unlayer(o["name"])
        elif op == "firm":
            import dasfirm
            said = dasfirm.undo_cert(con, o)
            if said:
                left.append(said)
    if jid and job:
        _log(con, jid, f"Intake undid {it['name']}")
    _put(con, iid, status="undone", dest="Undone" + (": " + "; ".join(left) if left else ""), undo=[], job_why=it["job_why"], done_at=das.now(),
         facts={k: v for k, v in it["facts"].items() if k != "registered"})
    con.commit()


def to_register(con, iid, d, ctx):
    """A person pressed Update the register on a calibration certificate. Only the register: each job keeps its own copy until a person takes
    the new date there (dasfirm.py). It can be taken back, with Undo on what was filed or on its own."""
    import dasfirm
    it = _get(con, iid, ctx)
    src = held(iid)
    if not os.path.exists(src) and it.get("job_id") and it["facts"].get("saved"):
        j = das.job_row(con, it["job_id"])
        src = das.file_path(j["id"], j["name"], it["facts"]["saved"]) if j else None
    op = dasfirm.from_cert(con, it, src, (d or {}).get("model"), ctx.by)
    _put(con, iid, undo=[*it["undo"], op], facts={**it["facts"], "registered": op["id"]})
    con.commit()
    return public(con, _raw(con, iid))


def off_register(con, iid, ctx):
    """That press taken back."""
    import dasfirm
    it = _get(con, iid, ctx)
    ops = [o for o in it["undo"] if o.get("op") == "firm"]
    said = [x for x in (dasfirm.undo_cert(con, o) for o in reversed(ops)) if x]
    if said:
        raise ValueError(said[0] + ".")
    _put(con, iid, undo=[o for o in it["undo"] if o.get("op") != "firm"], facts={k: v for k, v in it["facts"].items() if k != "registered"})
    con.commit()
    return public(con, _raw(con, iid))


def undo_item(con, iid, ctx, force=False):
    it = _get(con, iid, ctx)
    if it["status"] not in ("filed", "applied", "kept"):
        raise ValueError("There's nothing to undo on this.")
    _undo(con, it, ctx, force)
    return public(con, _raw(con, iid))


def undo_batch(con, bid, ctx, force=False):
    _batch(con, bid, ctx)
    undone, stuck = 0, []
    for r in con.execute("SELECT id, name FROM intake_item WHERE batch_id=? AND status IN ('filed','applied','kept') ORDER BY id DESC", (bid,)).fetchall():
        try:
            _undo(con, _raw(con, r["id"]), ctx, force)
            undone += 1
        except Busy as e:
            stuck.append(str(e))
        except LookupError as e:
            stuck.append(f"{r['name']}: {e}")
    return dict(batch_view(con, bid, ctx), undone=undone, stuck=stuck)


# ---------------------------------------------------------------- what the page sees

def public(con, it):
    f = it["facts"]
    sc = it["scan"]
    info = KINDS.get(it["kind"]) or {}
    jn = None
    if it.get("job_id"):
        r = con.execute("SELECT name FROM das_job WHERE id=?", (it["job_id"],)).fetchone()
        jn = r["name"] if r else "a deleted job"
    import dasfirm
    return {"firm": dasfirm.cert_offer(con, it), "id": it["id"], "batch": it["batch_id"], "parent": it["parent_id"], "name": it["name"], "path": it["path"], "size": it["size"], "status": it["status"], "kind": it["kind"],
            "kind_label": label_of(it["kind"]) if it["kind"] else "", "conf": it["conf"], "why": it["why"], "job_id": it["job_id"], "job_name": jn, "job_why": it["job_why"], "dest": it["dest"],
            "mark": it["mark"], "checks": it["checks"], "problems": it["problems"], "virus": sc.get("virus") or NOT_SCANNED, "refused": sc.get("refused"), "plan": f.get("plan") or "",
            "needs": f.get("needs") or [], "insts": f.get("insts"), "suppliers": f.get("suppliers"), "candidates": f.get("candidates") or [], "maybe": f.get("maybe") or [], "guess": f.get("guess"),
            "tab": info.get("tab"), "act": info.get("act"), "pdf": it["status"] == "reading", "corrupt": bool(sc.get("corrupt")), "locked": bool(sc.get("locked")), "can_undo": it["status"] in ("filed", "applied", "kept") and bool(it["undo"]), "saved": f.get("saved")}


def counts(items):
    n = {"filed": 0, "waiting": 0, "pile": 0, "refused": 0, "reading": 0, "duplicate": 0}
    for x in items:
        s = x["status"]
        if s in ("filed", "applied", "kept"):
            n["filed"] += 1
        elif s in n:
            n[s] += 1
    n["files"] = sum(1 for x in items if x["status"] not in ("unpacked", "dropped"))
    return n


def batch_view(con, bid, ctx):
    rows = [_row(r) for r in con.execute("SELECT * FROM intake_item WHERE batch_id=? ORDER BY id", (bid,)).fetchall()]
    items = [public(con, r) for r in rows if ctx.sees(r)]
    return {"batch": bid, "items": items, "counts": counts(items), "jobs": sorted({x["job_id"] for x in items if x["job_id"]})}


def listing(con, ctx, limit=300):
    """What's open for this login: everything waiting on a person, and the last drops."""
    if not ctx.writes():
        return {"can": False, "items": [], "counts": counts([]), "virus": NOT_SCANNED}
    rows = [_row(r) for r in con.execute("SELECT * FROM intake_item WHERE status NOT IN ('dropped','scanning') ORDER BY id DESC LIMIT ?", (limit,)).fetchall()]
    items = [public(con, r) for r in rows if ctx.sees(r)]
    open_ = sum(1 for x in items if x["status"] in ("waiting", "pile", "reading") or (x["mark"] == "scan: needs a person" and x["status"] == "filed"))
    return {"can": True, "items": items, "counts": counts(items), "open": open_, "kinds": {k: label_of(k) for k in PICKABLE},
            "virus": ("ClamAV is on this machine" if _scanner()[0] else NOT_SCANNED)}


def checklist(con, job):
    """The server's half of a job's checklist: what each stage so far still needs (codecheck.stage_needs), and its files with what each one is. The page adds the AHJ's list
    (dasahj.js ahjPacketRows) and Start's checks, which live in the browser."""
    import codecheck
    d, stage = job["data"], job["stage"]
    i = das.STAGES.index(stage) if stage in das.STAGES else 0
    stages = [{"stage": s, "needs": codecheck.stage_needs(d, s)} for s in das.STAGES[:i + 1] if s != "Closed"]
    return {"job": {"id": job["id"], "name": job["name"], "stage": stage}, "stages": stages, "files": das.list_files(job["id"], job["name"], con)["files"]}


def set_kind(con, jid, name, kind, who=""):
    """A person says what a file on the job is."""
    if kind not in KINDS:
        raise ValueError("That isn't a kind Intake knows.")
    con.execute("INSERT INTO das_file(job_id, name, kind, source, at) VALUES(?,?,?,?,?) ON CONFLICT(job_id, name) DO UPDATE SET kind=excluded.kind, source=excluded.source, at=excluded.at",
                (jid, name, kind, "person", das.now()))
    con.commit()


def names_of_kind(con, jid, kind):
    return {r[0] for r in con.execute("SELECT name FROM das_file WHERE job_id=? AND kind=?", (jid, kind))}


def held_file(con, iid, ctx):
    """A held file for the browser's own PDF reader, or a person looking at the pile: (path, name). app.py streams it as a download, never to open. A refused one, never."""
    it = _get(con, iid, ctx)
    if not ctx.writes():
        raise dashist.NotAllowed("Your login is view only.")
    if it["scan"].get("refused") or it["status"] == "refused":
        raise dashist.NotAllowed("A refused file is never handed out.")
    if not os.path.exists(held(iid)):
        raise LookupError("The held copy of this file has been cleared.")
    return held(iid), it["name"]


def route(con, method, p, qs, body, ctx):
    """/api/intake. Returns (status, answer). body() reads what was sent. The upload and the download are app.py's: they need the socket."""
    if p == "/api/intake" and method == "GET":
        return 200, listing(con, ctx)
    if not ctx.writes():
        raise dashist.NotAllowed("Your login is view only.")
    if p == "/api/intake/batch" and method == "POST":
        d = body()
        return 200, {"id": new_batch(con, ctx, d.get("job"), d.get("label"))}
    m = re.match(r"^/api/intake/batch/(\d+)/(finish|apply|undo)$", p)
    if m and method == "POST":
        bid, a = int(m.group(1)), m.group(2)
        if a == "finish":
            return 200, finish(con, bid, ctx)
        if a == "apply":
            return 200, apply_batch(con, bid, ctx)
        return 200, undo_batch(con, bid, ctx, bool(body().get("force")))
    m = re.match(r"^/api/intake/item/(\d+)/(pdf|apply|keep|pick|undo|drop|newjob|register|unregister)$", p)
    if m and method == "POST":
        iid, a = int(m.group(1)), m.group(2)
        d = body()
        if a == "pdf":
            return 200, read_pdf(con, iid, d, ctx)
        if a == "apply":
            return 200, apply_item(con, iid, d, ctx)
        if a == "keep":
            return 200, keep_item(con, iid, ctx, d.get("job"))
        if a == "pick":
            return 200, move_item(con, iid, d.get("job"), ctx, d.get("kind") or None)
        if a == "newjob":
            return 200, new_job_for(con, iid, d, ctx)
        if a == "drop":
            return 200, drop_item(con, iid, ctx)
        if a == "register":
            return 200, to_register(con, iid, d, ctx)
        if a == "unregister":
            return 200, off_register(con, iid, ctx)
        try:
            return 200, undo_item(con, iid, ctx, bool(d.get("force")))
        except Busy as e:
            return 409, {"error": str(e), "ask": True}
    m = re.match(r"^/api/intake/job/(\d+)/checklist$", p)
    if m and method == "GET":
        ctx.gate(int(m.group(1)), "view")
        return 200, checklist(con, das.job_row(con, int(m.group(1))))
    m = re.match(r"^/api/intake/job/(\d+)/kind$", p)
    if m and method == "POST":
        ctx.gate(int(m.group(1)), "edit")
        d = body()
        set_kind(con, int(m.group(1)), str(d.get("name") or ""), str(d.get("kind") or ""))
        return 200, {"ok": True}
    return 404, {"error": "not found"}


def brief(con, made):
    out = []
    for i in made:
        r = con.execute("SELECT id, name, status FROM intake_item WHERE id=?", (i,)).fetchone()
        if r:
            out.append({"id": r["id"], "name": r["name"], "pdf": r["status"] == "reading"})
    return out


def labelled(answer):
    """A job's files with what each one is, in words."""
    for f in answer.get("files") or []:
        if f.get("kind"):
            f["kind_label"] = label_of(f["kind"])
    return answer


def from_mail(con, jid, name, data, login=""):
    """One attachment on tagged mail: the same scan, so what runs code never reaches Files this way either. Returns the name it's saved under, or None when it was
    refused, which leaves it on the Intake list with why. Everything else goes in as mail always has, with its kind recorded when the file alone can say."""
    j = das.job_row(con, jid)
    base = clean_name(name)
    tmp = os.path.join(stage_dir(), f"mail-{threading.get_ident()}-{time.time_ns()}.part")
    with open(tmp, "wb") as fh:
        fh.write(data)
    try:
        sc = scan_file(str(name or base), tmp, len(data))
        if not (sc["refused"] or not _safe_to_serve(base)):
            saved = das.save_file(jid, j["name"], base, data)
            kind = None
            try:
                kind = recognise(base, tmp, sc).get("kind")
            except Exception:  # a kind is a nicety here: the file's saved
                pass
            con.execute("INSERT OR REPLACE INTO das_file(job_id, name, sha256, kind, source, at) VALUES(?,?,?,?,?,?)", (jid, saved, hashlib.sha256(data).hexdigest(), kind if KINDS.get(kind, {}).get("act") == "file" else None, "mail", das.now()))
            con.commit()
            return saved
        cur = con.execute("INSERT INTO intake_batch(who, source, job_id, label, created_at, done_at) VALUES(?,?,?,?,?,?)", (login, "mail", jid, base[:120], das.now(), das.now()))
        reason = sc["refused"] or "This can't go in a job's Files, because a browser would run it."
        sc["refused"] = reason
        ins = con.execute("INSERT INTO intake_item(batch_id, who, name, path, sha256, size, type, job_id, job_why, status, scan, problems, facts, at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (cur.lastrowid, login, base, "", hashlib.sha256(data).hexdigest(), len(data), sc["type"], jid, "It came on this job's tagged mail", "refused", json.dumps(sc),
                           json.dumps([{"level": "bad", "text": reason}]), "{}", das.now()))
        os.replace(tmp, held(ins.lastrowid))
        con.commit()
        return None
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
