"""
A small .xlsx writer, standard library only: the bill of materials' workbook (dasbom.py). Sheets are plain lists of rows
and a cell is a value, or a dict with a style, a formula and the value the formula gives now. Each formula is written with
that value beside it, so anything that reads a file without recalculating (das._xlsx_table, a phone's preview) sees the
right number, and the workbook asks Excel to recalculate on opening.

The order of a worksheet's elements is fixed by ECMA-376 (CT_Worksheet): Excel calls a file corrupt if it's out of order.
WORKSHEET_ORDER below is that order, and tests/test_xlsxout.py checks every sheet against it.
"""
import io
import re
import time
import zipfile
from xml.sax.saxutils import escape, quoteattr

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WORKSHEET_ORDER = ("sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "autoFilter", "mergeCells",
                   "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter")
MAX_TEXT = 32767  # Excel's limit for one cell
BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")

FONTS = ('<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
         '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>',
         '<font><b/><sz val="15"/><name val="Calibri"/><family val="2"/></font>',
         '<font><sz val="10"/><color rgb="FF5A6472"/><name val="Calibri"/><family val="2"/></font>',
         '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>',
         '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/></font>')
FILLS = ('<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
         '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2A37"/><bgColor indexed="64"/></patternFill></fill>',
         '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE3EC"/><bgColor indexed="64"/></patternFill></fill>',
         '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F4F8"/><bgColor indexed="64"/></patternFill></fill>')
BORDERS = ('<border><left/><right/><top/><bottom/><diagonal/></border>',
           '<border><left/><right/><top/><bottom style="hair"><color rgb="FF9AA5B1"/></bottom><diagonal/></border>',
           '<border><left/><right/><top style="thin"><color rgb="FF1F2A37"/></top><bottom/><diagonal/></border>',
           '<border><left/><right/><top style="thin"><color rgb="FF1F2A37"/></top><bottom style="double"><color rgb="FF1F2A37"/></bottom><diagonal/></border>')
NUM_MONEY = 164  # 164 up is the file's own number formats
NUMFMTS = f'<numFmts count="1"><numFmt numFmtId="{NUM_MONEY}" formatCode="&quot;$&quot;#,##0.00"/></numFmts>'
# a style's name -> (font, fill, border, number format, horizontal, wrap)
STYLES = {"": (0, 0, 0, 0, None, False), "title": (2, 0, 0, 0, None, False), "sub": (3, 0, 0, 0, None, False),
          "head": (4, 2, 0, 0, "left", True), "head_n": (4, 2, 0, 0, "right", True), "group": (1, 3, 0, 0, None, False),
          "text": (0, 0, 1, 0, None, False), "wrap": (0, 0, 1, 0, None, True), "num": (0, 0, 1, 0, "right", False),
          "money": (0, 0, 1, NUM_MONEY, "right", False), "center": (0, 0, 1, 0, "center", False), "link": (5, 0, 1, 0, None, True),
          "sub_l": (1, 4, 2, 0, None, False), "sub_m": (1, 4, 2, NUM_MONEY, "right", False), "sub_n": (1, 4, 2, 0, "right", False),
          "total_l": (1, 0, 3, 0, None, False), "total_m": (1, 0, 3, NUM_MONEY, "right", False), "total_n": (1, 0, 3, 0, "right", False)}
STYLE_ID = {name: i for i, name in enumerate(STYLES)}


def col_name(n):
    """0 -> A, 25 -> Z, 26 -> AA."""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def clean(s):
    return BAD_XML.sub("", str(s))[:MAX_TEXT]


def sheet_name(s, used=()):
    """A name Excel takes: 31 characters at most, none of []:*?/\\, not starting or ending with an apostrophe, unique."""
    base = re.sub(r"[\[\]:*?/\\]", " ", clean(s)).strip(" '")[:31] or "Sheet"
    name, i = base, 2
    while name.lower() in {u.lower() for u in used}:
        tail = f" {i}"
        name, i = base[:31 - len(tail)] + tail, i + 1
    return name


def _num(v):
    return repr(int(v)) if isinstance(v, int) or float(v).is_integer() and abs(v) < 1e15 else repr(float(v))


def _xf(f, fl, b, nf, al, wr):
    """One cell format. Nothing inside an f-string's braces uses a backslash or its own quote: the server may be older than 3.12."""
    a = [f'numFmtId="{nf}"', f'fontId="{f}"', f'fillId="{fl}"', f'borderId="{b}"', 'xfId="0"']
    a += [t for on, t in ((nf, 'applyNumberFormat="1"'), (f, 'applyFont="1"'), (fl, 'applyFill="1"'), (b, 'applyBorder="1"')) if on]
    if not (al or wr):
        return "<xf " + " ".join(a) + "/>"
    align = ['vertical="top"'] + ([f'horizontal="{al}"'] if al else []) + (['wrapText="1"'] if wr else [])
    return "<xf " + " ".join(a) + ' applyAlignment="1"><alignment ' + " ".join(align) + "/></xf>"


def _styles():
    xfs = "".join(_xf(*x) for x in STYLES.values())
    return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="{NS}">{NUMFMTS}'
            f'<fonts count="{len(FONTS)}">{"".join(FONTS)}</fonts><fills count="{len(FILLS)}">{"".join(FILLS)}</fills>'
            f'<borders count="{len(BORDERS)}">{"".join(BORDERS)}</borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            f'<cellXfs count="{len(STYLES)}">{xfs}</cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>')


class _Strings:
    def __init__(self):
        self.ids, self.n = {}, 0

    def add(self, s):
        self.n += 1
        return self.ids.setdefault(s, len(self.ids))

    def xml(self):
        items = "".join(f'<si><t xml:space="preserve">{escape(s)}</t></si>' for s in self.ids)
        return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="{NS}" count="{self.n}" uniqueCount="{len(self.ids)}">{items}</sst>'


def _cell(ref, c, strings, default=""):
    d = c if isinstance(c, dict) else {"v": c}
    v, f, st = d.get("v"), d.get("f"), STYLE_ID[d.get("s", default)]
    s = f' s="{st}"' if st else ""
    if f:
        body = f"<f>{escape(clean(f))}</f>"
        if isinstance(v, str):
            return f'<c r="{ref}"{s} t="str">{body}<v>{escape(clean(v))}</v></c>'
        cached = f"<v>{_num(v)}</v>" if v is not None else ""
        return f'<c r="{ref}"{s}>{body}{cached}</c>'
    if v is None or v == "":
        return f'<c r="{ref}"{s}/>' if st else ""
    if isinstance(v, bool):
        v = "Yes" if v else "No"
    if isinstance(v, (int, float)):
        return f'<c r="{ref}"{s}><v>{_num(v)}</v></c>'
    return f'<c r="{ref}"{s} t="s"><v>{strings.add(clean(v))}</v></c>'  # text stays text: "=SUM(1)" in a note is never run


def _list(choices):
    return escape('"' + ",".join(choices) + '"')


def _sheet(sh, strings, n):
    rows, cols = sh["rows"], sh.get("cols") or []
    ncols = max([len(r) for r in rows] + [1])
    body, links = [], []
    for ri, row in enumerate(rows, 1):
        cells = "".join(_cell(f"{col_name(ci)}{ri}", c, strings) for ci, c in enumerate(row))
        for ci, c in enumerate(row):
            if isinstance(c, dict) and c.get("url"):
                links.append((f"{col_name(ci)}{ri}", c["url"]))
        if cells:
            body.append(f'<row r="{ri}">{cells}</row>')
    head = sh.get("head_row")  # 1-based: the header row stays on screen and repeats on each printed page
    pane = (f'<pane ySplit="{head}" topLeftCell="A{head + 1}" activePane="bottomLeft" state="frozen"/>'
            f'<selection pane="bottomLeft" activeCell="A{head + 1}" sqref="A{head + 1}"/>') if head else ""
    x = [f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="{NS}" xmlns:r="{NS_R}">',
         '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>', f'<dimension ref="A1:{col_name(ncols - 1)}{max(len(rows), 1)}"/>',
         "<sheetViews><sheetView " + ('tabSelected="1" ' if n == 0 else "") + f'showGridLines="0" workbookViewId="0">{pane}</sheetView></sheetViews>',
         '<sheetFormatPr defaultRowHeight="15"/>']
    if cols:
        x.append("<cols>" + "".join(f'<col min="{i}" max="{i}" width="{w}" customWidth="1"/>' for i, w in enumerate(cols, 1)) + "</cols>")
    x.append("<sheetData>" + "".join(body) + "</sheetData>")
    if sh.get("filter"):
        x.append(f'<autoFilter ref="{sh["filter"]}"/>')
    if sh.get("merges"):
        x.append(f'<mergeCells count="{len(sh["merges"])}">' + "".join(f'<mergeCell ref="{m}"/>' for m in sh["merges"]) + "</mergeCells>")
    if sh.get("lists"):  # [(cell range, ["choice", ...])]: a drop-down in each cell
        x.append(f'<dataValidations count="{len(sh["lists"])}">' + "".join(
            f'<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="{r}"><formula1>{_list(ch)}</formula1></dataValidation>'
            for r, ch in sh["lists"]) + "</dataValidations>")
    rels = []
    if links:
        rels = [(f"rId{i}", url) for i, (_, url) in enumerate(links, 1)]
        x.append("<hyperlinks>" + "".join(f'<hyperlink ref="{ref}" r:id="rId{i}"/>' for i, (ref, _) in enumerate(links, 1)) + "</hyperlinks>")
    x.append('<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>')
    x.append('<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>')
    x.append(f'<headerFooter><oddFooter>{escape("&L" + clean(sh.get("footer") or "").replace("&", "&&") + "&RPage &P of &N")}</oddFooter></headerFooter>')
    x.append("</worksheet>")
    return "".join(x), rels


def workbook(sheets, title="", author="RF Recon"):
    """sheets: [{name, rows, cols (widths), head_row, filter, merges, lists, footer}] -> the .xlsx file's bytes."""
    used, strings, parts, rels = [], _Strings(), [], {}
    for i, sh in enumerate(sheets):
        used.append(sheet_name(sh.get("name") or f"Sheet{i + 1}", used))
        parts.append(None)
        parts[i], r = _sheet(sh, strings, i)
        if r:
            rels[i] = r
    quoted = lambda s: "'" + s.replace("'", "''") + "'"  # noqa: E731
    names = "".join(f'<definedName name="_xlnm.Print_Titles" localSheetId="{i}">{escape(quoted(used[i]))}!${sh["head_row"]}:${sh["head_row"]}</definedName>'
                    for i, sh in enumerate(sheets) if sh.get("head_row"))
    wb = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="{NS}" xmlns:r="{NS_R}">'
          '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>'
          + "".join(f'<sheet name={quoteattr(n)} sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(used, 1))
          + "</sheets>" + (f"<definedNames>{names}</definedNames>" if names else "") + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
    wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
               + "".join(f'<Relationship Id="rId{i}" Type="{NS_R}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(used) + 1))
               + f'<Relationship Id="rId{len(used) + 1}" Type="{NS_R}/styles" Target="styles.xml"/>'
               + f'<Relationship Id="rId{len(used) + 2}" Type="{NS_R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
    types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
             '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
             + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                       for i in range(1, len(used) + 1))
             + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
             '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
             '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>')
    root = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{NS_R}/officeDocument" Target="xl/workbook.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>')
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    core = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
            f'<dc:title>{escape(clean(title))}</dc:title><dc:creator>{escape(clean(author))}</dc:creator>'
            f'<dcterms:created xsi:type="dcterms:W3CDTF">{stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">{stamp}</dcterms:modified></cp:coreProperties>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", root)
        z.writestr("docProps/core.xml", core)
        z.writestr("xl/workbook.xml", wb)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        z.writestr("xl/styles.xml", _styles())
        z.writestr("xl/sharedStrings.xml", strings.xml())
        for i, xml in enumerate(parts, 1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", xml)
            if i - 1 in rels:
                z.writestr(f"xl/worksheets/_rels/sheet{i}.xml.rels",
                           '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                           + "".join(f'<Relationship Id="{rid}" Type="{NS_R}/hyperlink" Target={quoteattr(clean(url))} TargetMode="External"/>' for rid, url in rels[i - 1])
                           + "</Relationships>")
    return out.getvalue()
