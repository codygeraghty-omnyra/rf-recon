"""
API keys and logins (the "creds" setting), kept out of every database file, so no copy of the data (a kit, a backup,
a field pack, a copied folder) can carry them.

On Windows they are sealed with DPAPI for this Windows user and saved in %LOCALAPPDATA%\\RF Recon\\keys, one file per
data folder, so a test copy on another port never reads or overwrites the real keys. The sealed file opens only for
the same Windows user on the same PC. Elsewhere (and in the web version, which saves no keys) they sit in
~/.config/rf-recon/keys, readable by this user only. RF_RECON_KEYS names the file outright (tests).

Keys saved before 2026-11-02 sat in uls.db's setting table. migrate() moves them here on the first start and rebuilds
that table with secure_delete on, which zeroes its old pages, so no earlier copy of a key stays in the file.
"""
import hashlib
import json
import os

_WIN = os.name == "nt"


def path(data_dir, kind="keys"):
    """kind: "keys" (API keys and logins) or another sealed file beside it, e.g. "mail" (each login's mailbox)."""
    sfx = "" if kind == "keys" else "-" + kind
    if os.environ.get("RF_RECON_KEYS"):
        return os.environ["RF_RECON_KEYS"] + ("" if kind == "keys" else "." + kind)
    tag = hashlib.sha256(os.path.normcase(os.path.abspath(data_dir)).encode()).hexdigest()[:12]
    if _WIN:
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "RF Recon", "keys", tag + sfx + ".bin")
    return os.path.join(os.path.expanduser("~"), ".config", "rf-recon", "keys", tag + sfx + ".json")


def _dpapi(data, seal):
    import ctypes  # Windows only; the web version has no use for it

    class Blob(ctypes.Structure):
        _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    src, out = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), Blob()
    fn = ctypes.windll.crypt32.CryptProtectData if seal else ctypes.windll.crypt32.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, 0x1, ctypes.byref(out)):  # 0x1: never show a prompt
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def exists(data_dir, kind="keys"):
    return os.path.exists(path(data_dir, kind))


def load(data_dir, kind="keys"):
    """The saved keys; {} when there are none, or the file won't open (sealed by another Windows user or PC)."""
    try:
        with open(path(data_dir, kind), "rb") as fh:
            raw = fh.read()
        return json.loads(_dpapi(raw, False) if _WIN else raw)
    except (OSError, ValueError):
        return {}


def save(data_dir, creds, kind="keys"):
    p = path(data_dir, kind)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    raw = json.dumps(creds).encode()
    tmp = p + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as fh:
        fh.write(_dpapi(raw, True) if _WIN else raw)
    os.replace(tmp, p)


def migrate(con, data_dir):
    """Move keys out of uls.db's setting table (once), then rebuild the table so none of their bytes stay in the file.
    Keys already in the store win: a row left in the database is an old copy. Returns how many keys were moved."""
    row = con.execute("SELECT v FROM setting WHERE k='creds'").fetchone()
    if not row:
        return 0
    old = json.loads(row[0] or "{}") or {}
    moved = 0
    if not load(data_dir):
        save(data_dir, old)
        if load(data_dir) != old:
            raise RuntimeError("the key store did not read back what was saved; keys left where they were")
        moved = len(old)
    con.commit()
    con.execute("PRAGMA secure_delete=ON")
    con.executescript("""
        BEGIN;
        CREATE TABLE setting_new(k TEXT PRIMARY KEY, v TEXT);
        INSERT INTO setting_new SELECT k, v FROM setting WHERE k <> 'creds';
        DROP TABLE setting;
        ALTER TABLE setting_new RENAME TO setting;
        COMMIT;
    """)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return moved
