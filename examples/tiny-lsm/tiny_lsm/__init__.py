"""A small log-structured merge-tree key-value store, for reading."""
from .db import DB
from .encoding import CorruptionError
from .options import Options

__all__ = ["DB", "CorruptionError", "Options"]
