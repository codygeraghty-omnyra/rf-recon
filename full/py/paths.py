"""
Where the folders that sit beside the code are: DAS jobs, field packs, docs (the research database), backups, notes and
the install kit.

In an install kit they sit beside the app folder. On Cody's PC the code moved out of Google Drive on 11/3 (to
the PC's own app folder outside Drive, Cody: "DO this ... taking the code's working folder out of Google Drive"), while those
folders stay in Drive: RF_RECON_ROOT names it (the launcher sets it), else the Drive folder when the code's own parent
has no docs, else the code's parent.
"""
import os

APP = os.path.dirname(os.path.abspath(__file__))
# the Drive folder took the product's new name with it (11/7, Cody: "fix them all"); the old name while a PC hasn't synced it yet
DRIVE_OLD = r"G:\My Drive\RF Recon"
DRIVE = r"G:\My Drive\DAStastic" if os.path.isdir(r"G:\My Drive\DAStastic") or not os.path.isdir(DRIVE_OLD) else DRIVE_OLD


def root():
    if os.environ.get("RF_RECON_ROOT"):
        return os.environ["RF_RECON_ROOT"]
    parent = os.path.dirname(APP)
    if not os.path.isdir(os.path.join(parent, "docs")) and os.path.isdir(os.path.join(DRIVE, "docs")):
        return DRIVE
    return parent


ROOT = root()
