# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow", "pillow-heif", "pyyaml", "imageio-ffmpeg"]
# ///
"""把 content/ 里的照片、文字和视频整理成网站要用的文件。

用法（在项目根目录）：  uv run tools/build.py

输入（只留在你电脑上，不会上传原件）：
  content/site.yaml                 网站标题、名字、在一起的日期
  content/places/<文件夹>/place.md  每个地方一份说明（开头是基本信息，下面是经历）
  content/places/<文件夹>/*.jpg     这个地方的照片（也支持 HEIC、PNG、WEBP）
  content/videos/<年份>*.mp4        每年的视频，可以配同名 .md 写标题和说明

输出（会被部署上网）：
  public/data/story.json            网站读取的数据
  public/media/p/...                压缩后的照片和缩略图（去掉了 EXIF 信息）
  public/media/v/...                切成小段的视频（HLS），每段远小于 Cloudflare 25 MB 的单文件上限
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

import yaml
from PIL import ExifTags, Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # 没装也能处理普通 JPG
    pass

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
PUBLIC = ROOT / "public"
MEDIA = PUBLIC / "media"
CACHE_FILE = ROOT / ".cache" / "photos.json"

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}
WEB_MAX = 2000  # 大图最长边（像素）
THUMB_MAX = 480  # 缩略图最长边
MAX_ASSET = 25 * 1024 * 1024  # Cloudflare 单个文件上限

Image.MAX_IMAGE_PIXELS = 300_000_000


def main() -> None:
    if not CONTENT.exists():
        sys.exit("找不到 content/ 文件夹。")
    site = load_site()
    cache = json.loads(CACHE_FILE.read_text("utf-8")) if CACHE_FILE.exists() else {}
    keep: set[Path] = set()

    places = build_places(cache, keep)
    videos = build_videos(keep)
    clean_media(keep)

    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), "utf-8")
    (PUBLIC / "data").mkdir(parents=True, exist_ok=True)
    data = {"site": site, "places": places, "videos": videos}
    (PUBLIC / "data" / "story.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")

    n_photos = sum(len(p["photos"]) for p in places)
    n_files = sum(1 for f in PUBLIC.rglob("*") if f.is_file())
    print(f"\n完成：{len(places)} 个地方，{n_photos} 张照片，{len(videos)} 个视频。")
    print(f"public/ 里共 {n_files} 个文件（Cloudflare 免费版上限 20000 个）。")
    if n_files > 18000:
        print("！文件数接近上限，可以考虑减少照片或把视频切得长一点。")


# ---------- 网站基本信息 ----------
def load_site() -> dict:
    path = CONTENT / "site.yaml"
    raw = yaml.safe_load(path.read_text("utf-8-sig")) if path.exists() else {}
    raw = raw or {}
    return {
        "title": str(raw.get("title") or "我们的故事"),
        "couple": str(raw.get("couple") or ""),
        "start_date": to_iso(raw.get("start_date")),
        "map_style": raw.get("map_style") or "https://tiles.openfreemap.org/styles/positron",
        "map_language": raw.get("map_language") or "zh",
        "map_theme": raw.get("map_theme") or "watercolor",
    }


# ---------- 地点和照片 ----------
def build_places(cache: dict, keep: set[Path]) -> list[dict]:
    root = CONTENT / "places"
    places = []
    if not root.exists():
        return places
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        md = folder / "place.md"
        meta, text = read_md(md) if md.exists() else ({}, "")
        pid = "p-" + hashlib.sha1(folder.name.encode("utf-8")).hexdigest()[:8]
        out_dir = MEDIA / "p" / pid
        captions = {str(k): str(v) for k, v in (meta.get("captions") or {}).items()}

        photos = []
        files = sorted(f for f in folder.iterdir() if f.suffix.lower() in IMAGE_EXT)
        for f in files:
            try:
                info = process_photo(f, out_dir, cache, keep)
            except Exception as e:  # 一张坏图不影响其他
                print(f"  ！跳过 {f.relative_to(CONTENT)}：{e}")
                continue
            photos.append({**info, "file": f.name, "caption": captions.get(f.name, "")})
        photos.sort(key=lambda p: (p["taken"] or "9999", p["file"]))

        lat, lng = meta.get("lat"), meta.get("lng")
        if lat is None or lng is None:
            gps = [(p["lat"], p["lng"]) for p in photos if p["lat"] is not None]
            if gps:
                lat = sum(g[0] for g in gps) / len(gps)
                lng = sum(g[1] for g in gps) / len(gps)
                print(f"  {folder.name}：没写坐标，用照片里的 GPS 定位")
            else:
                print(f"  ！{folder.name}：没有坐标（place.md 写 lat/lng，或照片带 GPS），不会出现在地图上")
        taken_days = sorted(p["taken"][:10] for p in photos if p["taken"])
        start = to_iso(meta.get("date")) or (taken_days[0] if taken_days else None)
        end = to_iso(meta.get("end_date")) or (taken_days[-1] if taken_days and taken_days[-1] != start else None)

        cover_name = meta.get("cover")
        cover = next((p for p in photos if p["file"] == cover_name), photos[0] if photos else None)
        # 带上每张照片自己的 GPS，网页上放大后会把照片画在拍摄地点
        public_photos = [
            {k: p[k] for k in ("src", "thumb", "w", "h", "taken", "caption", "lat", "lng")} for p in photos
        ]
        places.append({
            "id": pid,
            "title": str(meta.get("title") or re.sub(r"^\d{4}(-\d{1,2}){0,2}[-_ ]*", "", folder.name) or folder.name),
            "city": str(meta.get("city") or ""),
            "country": str(meta.get("country") or ""),
            "lat": round(float(lat), 6) if lat is not None else None,
            "lng": round(float(lng), 6) if lng is not None else None,
            "zoom": meta.get("zoom"),
            "date": start,
            "end_date": end,
            "text": text,
            "cover": {"src": cover["src"], "thumb": cover["thumb"]} if cover else None,
            "photos": public_photos,
        })
        print(f"  {folder.name}：{len(photos)} 张照片")
    places.sort(key=lambda p: p["date"] or "")
    return places


def process_photo(src: Path, out_dir: Path, cache: dict, keep: set[Path]) -> dict:
    st = src.stat()
    key = f"{src.relative_to(CONTENT).as_posix()}|{st.st_size}|{st.st_mtime_ns}"
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
    web, thumb = out_dir / f"{h}.jpg", out_dir / f"{h}_t.jpg"
    keep.update({web, thumb})
    if h in cache and web.exists() and thumb.exists():
        info = cache[h]
    else:
        out_dir.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            taken, lat, lng = read_exif(im)
            im = ImageOps.exif_transpose(im).convert("RGB")
            big = im.copy()
            big.thumbnail((WEB_MAX, WEB_MAX), Image.LANCZOS)
            big.save(web, "JPEG", quality=82, optimize=True, progressive=True)
            small = im.copy()
            small.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
            small.save(thumb, "JPEG", quality=76, optimize=True, progressive=True)
        info = {"w": big.width, "h": big.height, "taken": taken, "lat": lat, "lng": lng}
        cache[h] = info
    rel = lambda p: p.relative_to(PUBLIC).as_posix()  # noqa: E731
    return {**info, "src": rel(web), "thumb": rel(thumb)}


def read_exif(im: Image.Image) -> tuple[str | None, float | None, float | None]:
    exif = im.getexif()
    taken = None
    raw = exif.get_ifd(ExifTags.IFD.Exif).get(ExifTags.Base.DateTimeOriginal) or exif.get(ExifTags.Base.DateTime)
    if raw:
        try:
            taken = datetime.strptime(str(raw).strip("\x00 "), "%Y:%m:%d %H:%M:%S").isoformat()
        except ValueError:
            pass
    lat = lng = None
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    try:
        if gps and 2 in gps and 4 in gps:
            lat = dms(gps[2], gps.get(1, "N"))
            lng = dms(gps[4], gps.get(3, "E"))
            if lat == 0 and lng == 0:
                lat = lng = None
    except (TypeError, ValueError, ZeroDivisionError):
        lat = lng = None
    return taken, lat, lng


def dms(value, ref) -> float:
    d, m, s = (float(x) for x in value)
    ref = ref.decode() if isinstance(ref, bytes) else str(ref)
    v = d + m / 60 + s / 3600
    return round(-v if ref.strip().upper() in ("S", "W") else v, 6)


# ---------- 视频 ----------
def build_videos(keep: set[Path]) -> list[dict]:
    root = CONTENT / "videos"
    videos = []
    if not root.exists():
        return videos
    files = sorted(f for f in root.iterdir() if f.suffix.lower() in VIDEO_EXT)
    if not files:
        return videos
    from imageio_ffmpeg import get_ffmpeg_exe

    ffmpeg = get_ffmpeg_exe()
    for f in files:
        m = re.match(r"^(\d{4})[-_ ]*(.*)$", f.stem)
        if not m:
            print(f"  ！跳过 {f.name}：文件名要以年份开头，例如 2024-我们的一年.mp4")
            continue
        meta, text = read_md(f.with_suffix(".md")) if f.with_suffix(".md").exists() else ({}, "")
        year = m.group(1)
        st = f.stat()
        h = hashlib.sha1(f"{f.name}|{st.st_size}|{st.st_mtime_ns}".encode("utf-8")).hexdigest()[:10]
        out = MEDIA / "v" / f"{year}-{h}"
        if not (out / "index.m3u8").exists():
            print(f"  转码视频 {f.name}（可能要几分钟）...")
            try:
                convert_video(ffmpeg, f, out)
            except RuntimeError as e:
                print(f"  ！{f.name} 转码失败，先跳过：{e}")
                continue
        else:
            print(f"  视频 {f.name}：已转码，跳过")
        for seg in out.iterdir():
            keep.add(seg)
            if seg.stat().st_size > MAX_ASSET:
                print(f"  ！{seg.name} 超过 25 MB，Cloudflare 会拒绝上传")
        videos.append({
            "year": year,
            "title": str(meta.get("title") or m.group(2) or f"{year} 年"),
            "text": text,
            "src": (out / "index.m3u8").relative_to(PUBLIC).as_posix(),
            "poster": (out / "poster.jpg").relative_to(PUBLIC).as_posix() if (out / "poster.jpg").exists() else None,
        })
    return videos


def convert_video(ffmpeg: str, src: Path, out: Path) -> None:
    tmp = out.with_name(out.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    run([
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale=-2:'trunc(min(720,ih)/2)*2'",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-force_key_frames", "expr:gte(t,n_forced*6)",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-hls_time", "6", "-hls_playlist_type", "vod",
        "-hls_segment_filename", str(tmp / "seg_%04d.ts"), str(tmp / "index.m3u8"),
    ])
    for ss in ("3", "0"):
        try:
            run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-ss", ss, "-i", str(src),
                 "-frames:v", "1", "-vf", "scale=-2:'trunc(min(720,ih)/2)*2'", "-q:v", "3", str(tmp / "poster.jpg")])
            if (tmp / "poster.jpg").exists():
                break
        except RuntimeError:
            continue
    shutil.rmtree(out, ignore_errors=True)
    tmp.rename(out)


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-800:] or "ffmpeg 失败")


# ---------- 公共小工具 ----------
def read_md(path: Path) -> tuple[dict, str]:
    text = path.read_text("utf-8-sig")
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if not m:
        return {}, text.strip()
    return (yaml.safe_load(m.group(1)) or {}), m.group(2).strip()


def to_iso(v) -> str | None:
    if v is None or v == "":
        return None
    if isinstance(v, (date, datetime)):
        return v.isoformat()[:10]
    return str(v).strip()


def clean_media(keep: set[Path]) -> None:
    """删掉已经不用的生成文件（只动 public/media 里的东西）。"""
    if not MEDIA.exists():
        return
    keep_resolved = {p.resolve() for p in keep}
    removed = 0
    for f in sorted(MEDIA.rglob("*"), reverse=True):
        if f.is_file() and f.resolve() not in keep_resolved:
            f.unlink()
            removed += 1
        elif f.is_dir() and not any(f.iterdir()):
            f.rmdir()
    if removed:
        print(f"  清理了 {removed} 个不再使用的旧文件")


if __name__ == "__main__":
    main()
