"""Stop all downloads (Cody 11/4: "add a button on to stop all downloads").

One switch for the whole app. Data & updates › ■ Stop all downloads sets it: every download that streams a file
(FCC licences, carrier coverage, prospect lists, Artemis) stops at its next megabyte, the updater starts nothing new and
skips the sources still waiting in its batch, and automatic updates stay off until Resume downloads. A file cut short is
left as its .part, never in place of the copy RF Recon already has. Kept across restarts (the setting update.stopped).

Not a subclass of OSError on purpose: download loops that retry on network errors (bdc.py) must not retry a stop."""
import threading

_EV = threading.Event()


class Stopped(Exception):
    """Raised inside a download when Stop all downloads was pressed."""


def stopped():
    return _EV.is_set()


def stop():
    _EV.set()


def resume():
    _EV.clear()


def check():
    """Call between chunks of a download: raises Stopped once downloads are stopped."""
    if _EV.is_set():
        raise Stopped("downloads stopped")
