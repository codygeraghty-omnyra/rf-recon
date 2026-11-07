"""
Old .xls workbooks (Excel 97-2003) read with the standard library, for lists exported from older report tools: iBwave's
own charts name .xls as its Excel export. A .xls is an OLE2 compound file holding a "Workbook" stream of BIFF records; this reads the
sheets' text and numbers and nothing else: no formats, no formulas (a formula's last value is read). Layouts from Microsoft's
[MS-CFB] and [MS-XLS] open specifications. tests/fixtures/equipment_list.xls is a real file saved by Excel.
"""
import struct

MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
END_OF_CHAIN = 0xFFFFFFFC  # at or above this a FAT entry isn't a sector number


def _chain(fat, start):
    out, n, seen = [], start, set()
    while n < END_OF_CHAIN and n < len(fat) and n not in seen:
        seen.add(n)
        out.append(n)
        n = fat[n]
    return out


def workbook_stream(data):
    """The BIFF stream out of the compound file."""
    if data[:8] != MAGIC or len(data) < 512:
        raise ValueError("That isn't an old Excel file.")
    u32 = lambda o: struct.unpack_from("<I", data, o)[0]  # noqa: E731
    size, mini = 1 << min(struct.unpack_from("<H", data, 30)[0], 16), 1 << min(struct.unpack_from("<H", data, 32)[0], 16)
    if size not in (512, 4096):
        raise ValueError("That file's layout isn't one Excel writes.")
    sector = lambda n: data[(n + 1) * size:(n + 2) * size]  # noqa: E731
    difat = [x for x in struct.unpack_from("<109I", data, 76)]
    nxt, left = u32(68), u32(72)
    while nxt < END_OF_CHAIN and left:
        vals = struct.unpack(f"<{size // 4}I", sector(nxt))
        difat += vals[:-1]
        nxt, left = vals[-1], left - 1
    fat = []
    for s in difat[:u32(44)]:
        if s < END_OF_CHAIN:
            fat += struct.unpack(f"<{size // 4}I", sector(s))
    read = lambda start: b"".join(sector(n) for n in _chain(fat, start))  # noqa: E731
    entries = read(u32(48))
    root, found = None, None
    for i in range(0, len(entries) - 127, 128):
        e = entries[i:i + 128]
        name = e[:max(struct.unpack_from("<H", e, 64)[0] - 2, 0)].decode("utf-16-le", "replace")
        start, length = struct.unpack_from("<I", e, 116)[0], struct.unpack_from("<I", e, 120)[0]
        if e[66] == 5:
            root = (start, length)
        elif e[66] == 2 and name in ("Workbook", "Book") and not found:
            found = (start, length)
    if not found:
        raise ValueError("That file has no workbook in it.")
    start, length = found
    if length >= u32(56) or root is None:
        return read(start)[:length]
    ministream, minifat_raw = read(root[0]), read(u32(60))
    minifat = list(struct.unpack(f"<{len(minifat_raw) // 4}I", minifat_raw[:len(minifat_raw) // 4 * 4]))
    return b"".join(ministream[n * mini:(n + 1) * mini] for n in _chain(minifat, start))[:length]


def _records(s, pos=0):
    while pos + 4 <= len(s):
        rid, n = struct.unpack_from("<HH", s, pos)
        yield rid, s[pos + 4:pos + 4 + n]
        pos += 4 + n


class _Reader:
    """Reads across a record and its CONTINUE records. A string's characters can break at a record's end, and each new record then
    starts with a byte saying whether the rest are one or two bytes wide."""

    def __init__(self, chunks):
        self.chunks, self.i, self.p = chunks, 0, 0

    def left(self):
        return len(self.chunks[self.i]) - self.p if self.i < len(self.chunks) else 0

    def _next(self):
        self.i, self.p = self.i + 1, 0
        if self.i >= len(self.chunks):
            raise IndexError

    def take(self, n):
        out = bytearray()
        while n:
            if not self.left():
                self._next()
            k = min(n, self.left())
            out += self.chunks[self.i][self.p:self.p + k]
            self.p += k
            n -= k
        return bytes(out)

    def chars(self, n, wide):
        out = []
        while n:
            if not self.left():
                self._next()
                wide = self.chunks[self.i][0] & 1
                self.p = 1
            k = min(n, self.left() // (2 if wide else 1))
            if not k:  # never split inside a character in a real file; move on rather than loop
                self._next()
                continue
            raw = self.chunks[self.i][self.p:self.p + k * (2 if wide else 1)]
            out.append(raw.decode("utf-16-le" if wide else "latin-1", "replace"))
            self.p += k * (2 if wide else 1)
            n -= k
        return "".join(out)


def _sst(chunks):
    r = _Reader(chunks)
    count = struct.unpack("<II", r.take(8))[1]
    out = []
    try:
        for _ in range(count):
            n, flags = struct.unpack("<HB", r.take(3))
            runs = struct.unpack("<H", r.take(2))[0] if flags & 8 else 0
            ext = struct.unpack("<I", r.take(4))[0] if flags & 4 else 0
            out.append(r.chars(n, flags & 1))
            r.take(runs * 4 + ext)
    except (IndexError, struct.error):
        pass  # a short table: what was read still fills the cells that name it
    return out


def _uni(b, wide_len=2):
    """A string in a record: length (one or two bytes), a flags byte, then its characters."""
    n = b[0] if wide_len == 1 else struct.unpack_from("<H", b, 0)[0]
    flags = b[wide_len]
    return b[wide_len + 1:wide_len + 1 + n * (2 if flags & 1 else 1)].decode("utf-16-le" if flags & 1 else "latin-1", "replace")


def _rk(v):
    if v & 2:
        n = float(struct.unpack("<i", struct.pack("<I", v & 0xFFFFFFFC))[0] >> 2)
    else:
        n = struct.unpack("<d", b"\0\0\0\0" + struct.pack("<I", v & 0xFFFFFFFC))[0]
    return n / 100 if v & 1 else n


def _text(n):
    return str(int(n)) if float(n).is_integer() and abs(n) < 1e15 else repr(float(n))


def _sheet(s, pos, sst, biff8):
    cells = {}
    last_formula = None
    for rid, b in _records(s, pos):
        if rid == 0x0A:  # the sheet's end
            break
        if rid in (0xFD, 0x203, 0x27E, 0x204, 0xD6, 0x06, 0xBD) and len(b) >= 6:
            row, col = struct.unpack_from("<HH", b, 0)
        if rid == 0xFD and len(b) >= 10:  # a string from the shared table
            i = struct.unpack_from("<I", b, 6)[0]
            cells[row, col] = sst[i] if i < len(sst) else ""
        elif rid == 0x203 and len(b) >= 14:  # a number
            cells[row, col] = _text(struct.unpack_from("<d", b, 6)[0])
        elif rid == 0x27E and len(b) >= 10:  # a compact number
            cells[row, col] = _text(_rk(struct.unpack_from("<I", b, 6)[0]))
        elif rid == 0xBD:  # several compact numbers in a row
            for k, i in enumerate(range(4, len(b) - 2, 6)):
                cells[row, col + k] = _text(_rk(struct.unpack_from("<I", b, i + 2)[0]))
        elif rid in (0x204, 0xD6):  # a string held in the cell
            cells[row, col] = _uni(b[6:]) if biff8 else b[8:8 + struct.unpack_from("<H", b, 6)[0]].decode("latin-1", "replace")
        elif rid == 0x06 and len(b) >= 14:  # a formula's last value; a text answer follows in a STRING record
            if b[12:14] == b"\xff\xff" and b[6] == 0:
                last_formula = (row, col)
            elif b[12:14] != b"\xff\xff":
                cells[row, col] = _text(struct.unpack_from("<d", b, 6)[0])
        elif rid == 0x207 and last_formula:
            cells[last_formula] = _uni(b) if biff8 else b[2:2 + struct.unpack_from("<H", b, 0)[0]].decode("latin-1", "replace")
            last_formula = None
    if not cells:
        return []
    rows = [[] for _ in range(max(r for r, _ in cells) + 1)]
    for (r, c), v in cells.items():
        if len(rows[r]) <= c:
            rows[r] += [""] * (c + 1 - len(rows[r]))
        rows[r][c] = v
    return rows


def tables(data):
    """[(sheet name, rows of strings)] from a .xls file's bytes, blank rows kept. A file it can't follow is a ValueError, never a crash."""
    try:
        return _tables(data)
    except (struct.error, IndexError, UnicodeError, MemoryError, OverflowError) as e:
        raise ValueError(f"That file's workbook can't be read: {e}")


def _tables(data):
    s = workbook_stream(data)
    recs = list(_records(s))
    if not recs or recs[0][0] != 0x809:
        raise ValueError("That file's workbook can't be read.")
    biff8 = struct.unpack_from("<H", recs[0][1], 0)[0] >= 0x0600
    sheets, sst = [], []
    for i, (rid, b) in enumerate(recs):
        if rid == 0x85 and len(b) >= 8:
            pos = struct.unpack_from("<I", b, 0)[0]
            name = _uni(b[6:], 1) if biff8 else b[7:7 + b[6]].decode("latin-1", "replace")
            if b[5] == 0:  # a worksheet, not a chart or a macro sheet
                sheets.append((name, pos))
        elif rid == 0xFC:
            chunks = [b]
            for r2, b2 in recs[i + 1:]:
                if r2 != 0x3C:
                    break
                chunks.append(b2)
            sst = _sst(chunks)
        elif rid == 0x0A:  # the workbook's globals end at the first EOF: the sheets follow
            break
    if not sheets:
        raise ValueError("That workbook has no worksheets.")
    return [(name, _sheet(s, pos, sst, biff8)) for name, pos in sheets]
