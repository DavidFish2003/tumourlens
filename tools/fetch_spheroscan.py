"""Download only the test split of the SpheroScan training data from Zenodo.

Source: "Supporting data for SpheroScan: A User-Friendly Deep Learning Tool for Spheroid
Image Analysis", Zenodo record 7555467 (CC0). The full zip is ~1.1 GB; HTTP range
requests let us pull just the ~100 test images and their expert annotations.

Run: uv run --no-project --with requests python tools/fetch_spheroscan.py
"""
import io
import zipfile
from pathlib import Path

import requests

URL = "https://zenodo.org/records/7555467/files/training-data.zip?download=1"
OUT = Path(__file__).resolve().parents[1] / "data" / "spheroscan"


class RangeFile(io.RawIOBase):
    """Read-only seekable file backed by HTTP range requests."""

    def __init__(self, url: str):
        self.url, self.s, self.pos = url, requests.Session(), 0
        r = self.s.get(url, headers={"Range": "bytes=0-0"}, timeout=60)
        r.raise_for_status()
        self.size = int(r.headers["Content-Range"].split("/")[-1])

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, offset, whence=0):
        self.pos = {0: 0, 1: self.pos, 2: self.size}[whence] + offset
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        for attempt in range(4):
            try:
                r = self.s.get(self.url, headers={"Range": f"bytes={self.pos}-{self.pos + n - 1}"}, timeout=120)
                r.raise_for_status()
                break
            except requests.RequestException:
                if attempt == 3:
                    raise
        b[: len(r.content)] = r.content
        self.pos += len(r.content)
        return len(r.content)


def main():
    z = zipfile.ZipFile(io.BufferedReader(RangeFile(URL), buffer_size=4 << 20))
    # Expert outlines (VGG Image Annotator JSON) exist for IncuCyte/test and microscope/val,
    # saved inside notebook checkpoint folders. Take those splits' images plus their annotations.
    splits = ("IncuCyte/test/", "microscope/val/")
    wanted = [i for i in z.infolist()
              if any(s in i.filename for s in splits) and not i.is_dir() and "__MACOSX" not in i.filename
              and not i.filename.endswith(".DS_Store")
              and (".ipynb" not in i.filename or i.filename.endswith("via_region_data-checkpoint.json"))]
    total = 0
    for i in wanted:
        dest = OUT / Path(i.filename).relative_to("training-data")
        if dest.exists() and dest.stat().st_size == i.file_size:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(z.read(i))
        total += i.file_size
        print(f"{dest.relative_to(OUT)}  {i.file_size / 1e3:.0f} KB", flush=True)
    print(f"done: {len(wanted)} files, {total / 1e6:.1f} MB new")


if __name__ == "__main__":
    main()
